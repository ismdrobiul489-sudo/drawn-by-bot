// Conversation bridge: the owner talks to ONE persistent OpenCode session
// exactly like a chat with Claude — plain text in, agent text out, files
// delivered through the outbox, questions/permissions through the relay.
// There is no form and no job queue any more: the session IS the product.
//
// Guards carried over from the job era, adapted to turns:
//  - Before the FIRST turn of a NEW session, the standing selection is
//    verified through the probe chain (resolveWorkingModel); a fallback
//    updates the saved selection and is announced as its own message.
//  - A turn that dies of a token limit (TPM) or a dead model switches the
//    standing selection per the same chain, announces it, and retries
//    ONCE with a short note prepended. A second failure is reported in
//    chat, in plain language, naming the cause — never a dead end.
//  - If the OpenCode server process dies, pending turns fail fast
//    (agent-server), the server is respawned, the persisted session is
//    re-attached (OpenCode keeps sessions on disk), the owner gets ONE
//    "Agent restarted — our conversation is intact." notice, and the
//    interrupted turn is retried once.
//  - Claims-vs-delivery: if a turn's text says a file was sent/rendered
//    but no send_file request arrived during the turn, ONE automatic
//    nudge turn asks the agent to actually send it or say what went
//    wrong. (The job-4 lesson: a run "finished", no mp4 existed, and the
//    failure pointed at a review.md that was never written.)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env, envInt, ROOT } from '../lib/env.mjs';
import { resolveWorkingModel, probeModel, PROVIDERS } from './models.mjs';

/** Float env (turn-watchdog minutes may be fractional in tests). */
function envFloat(key, fallback) {
  const n = parseFloat(env(key, ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Human duration for owner messages: "3 s" under a minute, else minutes. */
function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
}

// ── Agent memory (owner's lifecycle design) ─────────────────────────────────
// A session is the lifetime of ONE job: it opens with a request, carries
// revisions, and ENDS when the finished video is delivered (a send_file
// request with final=true → completeCurrentSession). Continuity across
// sessions comes from files the AGENT maintains in data/memory/:
//   preferences.md — standing preferences / behaviour notes (the core)
//   index.md       — ONE line per finished video: date — title — folder
// When a NEW session is created, the bridge prepends a compact brief
// (full preferences + the last ~10 index lines, ~4000 chars max).
export const MEMORY_DIR = join(ROOT, 'data', 'memory');
export const MEMORY_BRIEF_INTRO = '[Your memory from previous sessions — preferences and recent work. The current conversation starts fresh; use this for continuity.]';
const MEMORY_CAP = 4000;

export function ensureMemoryFiles() {
  try {
    mkdirSync(MEMORY_DIR, { recursive: true });
    for (const f of ['preferences.md', 'index.md']) {
      const p = join(MEMORY_DIR, f);
      if (!existsSync(p)) writeFileSync(p, '');
    }
  } catch { /* memory is best-effort; a missing dir just means no brief */ }
}

/** The compact brief prepended to a fresh session's first prompt, or ''. */
export function readMemoryBrief() {
  ensureMemoryFiles();
  let prefs = '', indexLines = [];
  try { prefs = readFileSync(join(MEMORY_DIR, 'preferences.md'), 'utf8').trim(); } catch {}
  try {
    indexLines = readFileSync(join(MEMORY_DIR, 'index.md'), 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
  } catch {}
  if (!prefs && !indexLines.length) return '';
  const build = lines => [
    MEMORY_BRIEF_INTRO,
    prefs ? `\n## Standing preferences\n${prefs}` : '',
    lines.length ? `\n## Recent finished videos (index)\n${lines.join('\n')}` : '',
  ].join('\n');
  let lines = indexLines.slice(-10);
  let brief = build(lines);
  while (brief.length > MEMORY_CAP && lines.length) { lines = lines.slice(1); brief = build(lines); } // oldest first
  if (brief.length > MEMORY_CAP) brief = brief.slice(0, MEMORY_CAP);
  return brief;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// A turn can die of the provider's free-tier SIZE limit even though the
// model itself is alive (the 1-token probe passes): Groq free allows
// 8K tokens/minute while a first turn is ~10.7K tokens. A TPM error also
// contains the word "model", so it must be classified BEFORE the
// dead-model matcher everywhere both are used.
const TOKEN_LIMIT_RE = /too large|tokens per minute|\btpm\b|rate.?limit|\b429\b|\b413\b|quota/i;
export function isTokenLimitError(message) {
  return TOKEN_LIMIT_RE.test(message || '');
}

const DEAD_MODEL_RE = /not provisioned|not found|\b404\b|model/i;
export function isDeadModelError(message) {
  const m = message || '';
  return !isTokenLimitError(m) && DEAD_MODEL_RE.test(m);
}

// Transient provider overload (live 2026-11-02: a turn died with
// `OpenCode session error: {"message":"Service temporarily overloaded",
// "type":"service_unavailable","code":503}`). The model is fine — the
// SERVICE is momentarily overloaded — so the cure is wait + retry the
// same turn, NOT a model switch. This class must be checked BEFORE the
// dead-model matcher: these payloads can carry the word "model".
const TRANSIENT_RE = /\b503\b|service_unavailable|temporarily overloaded|\boverloaded\b/i;
export function isTransientError(message) {
  return TRANSIENT_RE.test(message || '');
}

/** Our client lost the server itself (process death / unreachable). */
export function isServerGoneError(e) {
  if (!e) return false;
  if (e.serverDied) return true;
  return /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up/i.test(e.message || '');
}

// Conservative delivery-claim matcher: explicit delivery language tied to
// a file or a render — not mere mentions of a video.
const CLAIM_RES = [
  /\b(sent|delivered|uploaded|shared)\b[^.\n]{0,80}\.(mp4|mov|webm|mkv|srt|png|jpe?g|mp3)\b/i,
  /\b(animatic|final render|render|video|master)\b[^.\n]{0,50}\b(is ready|ready|done|complete|finished|rendered)\b/i,
  /\bsent (it|the video|the animatic|the render|the file)\b/i,
  /\bhere('s| is) (the|your) (video|animatic|render|file)\b/i,
];
export function looksLikeDeliveryClaim(text) {
  return CLAIM_RES.some(r => r.test(text || ''));
}

export const NUDGE_TEXT = '[System note: you said the file was ready, but nothing was sent to the chat. Please actually send it with the send_file tool, or say plainly what went wrong.]';

const FIRST_TURN_PREFIX = [
  '[Conversation start: this is a fresh conversation with the owner. Sessions here cover ONE job each and end when the finished video is delivered — a fresh chat is normal, never act surprised by it; the memory brief above (when present) is your continuity.',
  'You maintain your own memory files: data/memory/preferences.md (standing preferences — update it the moment he states one) and data/memory/index.md (one line per finished video, appended when you send the final file).',
  'The owner reaches you only through this chat: reply in his language; style, aspect and voice are collected by the bot\'s buttons before you are briefed — when a brief says the choices are already made, use them and never re-ask them, and NEVER use the question tool for style, aspect or voice; if something else material is missing, ask ONE short plain-text question and end your turn; never narrate your reasoning or tool intentions in chat — act, then report the result briefly; and deliver every file with the send_file tool — never claim a file was sent without calling it.]',
  '',
].join('\n');

/** Split a long text into Telegram-sized chunks (prefers newline cuts). */
export function splitText(text, limit = 4000) {
  const out = [];
  let rest = String(text || '');
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Verify a { provider, model } target actually answers (probe chain in
 * bot/models.mjs) and fall back if it is dead: the provider's .env
 * default, then the other provider's default. On a fallback the target
 * is rewritten and target.modelFellBack set; the switch is reported via
 * hooks.status AND hooks.announce (whichever exist). Throws — loudly,
 * naming everything tried — when no model answers at all.
 */
export async function ensureWorkingModel(target, hooks = {}) {
  const requested = `${target.provider}/${target.model}`;
  const notices = [];
  const notify = text => {
    notices.push(text);
    target.modelNotices = notices;
    return hooks.status ? hooks.status(`⚠️ ${text}`) : undefined;
  };
  const res = await resolveWorkingModel(target.provider, target.model, notify);
  if (!res.provider) {
    const detail = res.tried.map(t => `${t.provider}/${t.model} (${t.error || 'no response'})`).join('; ');
    throw new Error(`No working model found — nothing can run right now. Tried: ${detail}. Check the API keys in .env, or run: node scripts/check-models.mjs`);
  }
  target.modelResolution = res;
  if (res.fellBack) {
    const bad = res.tried.find(t => !t.ok);
    target.provider = res.provider;
    target.model = res.model;
    target.modelFellBack = true;
    const text = `⚠️ Model ${requested} didn't respond (${bad?.error || 'error'}) — switched to ${res.provider}/${res.model}. Continuing.`;
    await hooks.status?.(text);
    if (hooks.announce) { try { await hooks.announce(text); } catch { /* best-effort */ } }
  }
  return res;
}

export class Conversation {
  /**
   * deps:
   *  tg, agent (AgentServer), relay (AskRelay), outbox (Outbox|null)
   *  chatState(id) -> per-chat persisted state object; saveState()
   *  selectionOf(cs) -> {provider, model}; setSelection(cs, sel) persists it
   *  sessionDirectory — where the OpenCode session lives (repo root)
   *  settleMs — grace period after a turn for outbox arrivals to register
   */
  constructor({ tg, agent, relay, outbox = null, chatState, saveState, selectionOf, setSelection, sessionDirectory = ROOT, settleMs = 2000 }) {
    if (!tg || !agent || !chatState || !selectionOf) throw new Error('Conversation needs { tg, agent, chatState, saveState, selectionOf, setSelection }');
    this.tg = tg;
    this.agent = agent;
    this.relay = relay;
    this.outbox = outbox;
    this.chatState = chatState;
    this.saveState = saveState;
    this.selectionOf = selectionOf;
    this.setSelection = setSelection;
    this.sessionDirectory = sessionDirectory;
    this.settleMs = settleMs;
    this.running = new Map();      // chatId -> bool
    this.queues = new Map();       // chatId -> string[] (turn texts waiting)
    this.currentTexts = new Map(); // chatId -> text of the turn in flight (for guard retries)
    this.generations = new Map();  // chatId -> int (bumped by /new)
    this.abortFlags = new Set();   // chatId with a /cancel abort in flight
    this.acc = new Map();          // sessionId -> text accumulator
    this.servedChats = new Set();  // chats that have a conversation with us
    this.deathNoticeSent = false;  // ONE restart notice per death episode
    this.offEvent = agent.onEvent ? agent.onEvent(ev => { try { this.onAgentEvent(ev); } catch (e) { console.error('[conversation] event handling error:', e.message); } }) : null;
    this.offDeath = agent.onServerExit ? agent.onServerExit(() => { this.onServerDied().catch(() => {}); }) : null;
  }

  dispose() { this.offEvent?.(); this.offDeath?.(); }

  // ── Text accumulation + streaming delivery ──────────────────────────────

  onAgentEvent(ev) {
    const p = ev.properties || ev.data || {};
    const sid = p.sessionID;
    if (!sid) return;
    const acc = this.acc.get(sid);
    if (!acc) return;
    if (!acc.sawEvent) {
      acc.sawEvent = true;
      console.log(`[conversation] first agent event for chat ${acc.chatId} (${ev.type})`);
    }
    if (ev.type === 'message.part.delta' && p.field === 'text' && p.messageID) {
      if (acc.current && acc.current !== p.messageID) this.flushMessage(acc, acc.current);
      acc.current = p.messageID;
      if (!acc.order.includes(p.messageID)) acc.order.push(p.messageID);
      acc.byMsg.set(p.messageID, (acc.byMsg.get(p.messageID) || '') + (p.delta || ''));
    } else if (ev.type === 'message.part.updated') {
      // Defensive: some builds publish whole parts instead of deltas.
      const part = p.part;
      if (part?.type === 'text' && typeof part.text === 'string') {
        const mid = part.messageID || p.messageID;
        if (!mid) return;
        if (!acc.order.includes(mid)) acc.order.push(mid);
        if (part.text.length >= (acc.byMsg.get(mid) || '').length) acc.byMsg.set(mid, part.text);
      }
    }
  }

  flushMessage(acc, mid) {
    if (acc.flushed.has(mid)) return;
    acc.flushed.add(mid);
    const text = (acc.byMsg.get(mid) || '').trim();
    if (text) this.deliver(acc, text);
  }

  flushAll(acc) {
    for (const mid of acc.order) this.flushMessage(acc, mid);
    if (acc.current) this.flushMessage(acc, acc.current);
  }

  /** Send text to the chat, serialised per accumulator so milestone
   *  messages keep their order. Suppressed if /new superseded the turn. */
  deliver(acc, text) {
    if (acc.gen !== (this.generations.get(acc.chatId) || 0)) return;
    for (const chunk of splitText(text)) {
      acc.chain = acc.chain.then(() => this.tg.sendMessage(acc.chatId, chunk))
        .catch(e => console.error('[conversation] telegram delivery failed:', e.message));
    }
  }

  joinedText(acc) {
    return acc.order.map(id => acc.byMsg.get(id) || '').join('\n');
  }

  // ── Session lifecycle ───────────────────────────────────────────────────

  /** Make sure the chat has a live session; create one (after the
   *  new-session model guard) when needed. Returns { created }. */
  async ensureSession(chatId) {
    const cs = this.chatState(chatId);
    if (cs.sessionId) {
      // A resumed session (bot restart): re-teach the driver its
      // directory, or its events/status stay invisible (scoping).
      this.agent.trackDirectory?.(cs.sessionId, this.sessionDirectory);
      return { created: false };
    }
    const sel = this.selectionOf(cs);
    const target = { provider: sel.provider, model: sel.model };
    const say = t => this.tg.sendMessage(chatId, t).catch(() => {});
    // Hook mapping: `status` lines are probe PROGRESS (log only — the
    // processor era showed them on a rolling status message; here they
    // would spam the chat), `announce` is the persistent switch notice
    // the owner must actually see. Passing both as sends duplicates it.
    await ensureWorkingModel(target, { status: async t => console.log('[conversation] probe:', t), announce: say });
    if (target.modelFellBack) this.setSelection(cs, { provider: target.provider, model: target.model });
    cs.sessionId = await this.agent.createSession({
      providerID: target.provider, modelID: target.model,
      title: 'drawn-by-bot conversation', directory: this.sessionDirectory,
    });
    this.saveState();
    console.log(`[conversation] session created for chat ${chatId}: ${cs.sessionId} (model ${target.provider}/${target.model})`);
    return { created: true };
  }

  /** Session rotation on a FINAL delivery (owner's lifecycle rule):
   *  archive the current sessionId into the chat's past-sessions list
   *  and clear the pointer, so the NEXT owner message opens a fresh
   *  session. Deliberately does NOT bump the generation: the finishing
   *  turn's own summary text must still be delivered. */
  completeCurrentSession(chatId) {
    const cs = this.chatState(chatId);
    if (!cs.sessionId) return false;
    cs.pastSessions = [...(Array.isArray(cs.pastSessions) ? cs.pastSessions : []), { id: cs.sessionId, endedAt: Date.now() }].slice(-50);
    cs.sessionId = null;
    this.saveState();
    console.log(`[conversation] session rotated for chat ${chatId} (final delivery)`);
    return true;
  }

  /** /new: drop the session pointer (OpenCode archives it server-side),
   *  clear queued turns, and invalidate in-flight deliveries. */
  async newConversation(chatId) {
    const cs = this.chatState(chatId);
    this.generations.set(chatId, (this.generations.get(chatId) || 0) + 1);
    this.queues.set(chatId, []);
    if (cs.sessionId && this.running.get(chatId)) {
      this.abortFlags.add(chatId);
      await this.agent.abort(cs.sessionId).catch(() => {});
    }
    cs.sessionId = null;
    this.saveState();
  }

  /** /cancel: abort the running turn if there is one; otherwise clear
   *  the queued messages. Returns 'stopping' | 'cleared' | 'idle'. */
  async cancel(chatId) {
    const cs = this.chatState(chatId);
    if (this.running.get(chatId) && cs.sessionId) {
      this.abortFlags.add(chatId);
      await this.agent.abort(cs.sessionId).catch(() => {});
      return 'stopping';
    }
    const q = this.queues.get(chatId) || [];
    if (q.length) { this.queues.set(chatId, []); return 'cleared'; }
    return 'idle';
  }

  isRunning(chatId) { return !!this.running.get(chatId); }
  queueLength(chatId) { return (this.queues.get(chatId) || []).length; }

  // ── Server death (amendment A2) ─────────────────────────────────────────

  async onServerDied() {
    // Respawn eagerly so the next turn is instant, then ONE notice per
    // death episode to every chat with a live conversation. Sessions are
    // persisted by OpenCode on disk, so the conversation itself survives.
    try { await this.agent.ensure(); } catch { return; } // turn path will surface it
    if (this.deathNoticeSent) return;
    this.deathNoticeSent = true;
    for (const chatId of this.servedChats) {
      const cs = this.chatState(chatId);
      if (!cs.sessionId) continue;
      this.relay?.attach(cs.sessionId, chatId, 'chat');
      await this.tg.sendMessage(chatId, '🔄 Agent restarted — our conversation is intact.').catch(() => {});
    }
  }

  async deathNotice(chatId) {
    if (this.deathNoticeSent) return;
    this.deathNoticeSent = true;
    await this.tg.sendMessage(chatId, '🔄 Agent restarted — our conversation is intact.').catch(() => {});
  }

  // ── Turn submission + queue ─────────────────────────────────────────────

  /** Feed one owner message into the conversation. While a turn runs,
   *  messages queue (with a short note) and are delivered in order. */
  async submit(chatId, text) {
    this.servedChats.add(chatId);
    console.log(`[conversation] message received chat=${chatId}: ${JSON.stringify(String(text).slice(0, 40))}`);
    const q = this.queues.get(chatId) || [];
    q.push(text);
    this.queues.set(chatId, q);
    if (this.running.get(chatId)) {
      await this.tg.sendMessage(chatId, '📥 Queued — I will pass this to the agent as soon as it finishes what it is doing.').catch(() => {});
      return { queued: true };
    }
    this.pump(chatId).catch(async e => {
      // No silent paths: a pump-level failure reaches the owner in chat,
      // never just the console.
      console.error('[conversation] pump error:', e.message);
      await this.tg.sendMessage(chatId, `❌ Something went wrong while handling that message (${String(e.message || e).slice(0, 200)}) — please try again.`).catch(() => {});
    });
    return { queued: false };
  }

  async pump(chatId) {
    if (this.running.get(chatId)) return;
    this.running.set(chatId, true);
    try {
      for (;;) {
        const q = this.queues.get(chatId) || [];
        const text = q.shift();
        if (text === undefined) break;
        // Turn-start acknowledgement: the owner always sees the bot took
        // the job, even when the agent then works silently for a while.
        await this.tg.sendMessage(chatId, '🤔 On it…').catch(() => {});
        const outcome = await this.runTurn(chatId, text);
        if (outcome?.claimWithoutDelivery) {
          // ONE automatic nudge per turn chain — never a loop.
          await this.runTurn(chatId, NUDGE_TEXT, { isNudge: true });
        }
      }
    } finally {
      this.running.set(chatId, false);
    }
  }

  // ── One turn, with guards ───────────────────────────────────────────────

  /**
   * Await one prompt attempt under the turn watchdog:
   *  - no agent activity for TURN_STALL_MIN minutes (default 3) ⇒ the
   *    model stopped answering;
   *  - TURN_MAX_MIN minutes total (default 15) ⇒ absolute cap.
   * Either trip aborts the session turn, fails the waiter immediately,
   * and throws an error flagged .watchdog ('stall' | 'cap') that the
   * caller reports in chat, naming the model. While the relay holds a
   * pending ask for the session, the turn is waiting on the OWNER's
   * tap, not the model — the stall clock is held open (the relay's own
   * 30-minute reminder covers an unanswered ask).
   */
  async awaitPrompt(chatId, sessionId, promptPromise, sel) {
    const stallMs = Math.max(250, envFloat('TURN_STALL_MIN', 3) * 60000);
    const maxMs = Math.max(stallMs, envFloat('TURN_MAX_MIN', 15) * 60000);
    const startedAt = Date.now();
    let lastAct = startedAt;
    const outcome = await new Promise(resolve => {
      let done = false;
      const finish = v => { if (!done) { done = true; clearInterval(timer); resolve(v); } };
      promptPromise.then(() => finish({ ok: true }), err => finish({ ok: false, err }));
      const checkMs = Math.max(50, Math.min(1000, Math.floor(Math.min(stallMs, maxMs) / 10)));
      const timer = setInterval(() => {
        const act = this.agent.lastActivityAt?.(sessionId) || 0;
        if (act > lastAct) lastAct = act;
        if (this.relay?.hasPendingFor?.(sessionId)) lastAct = Date.now();
        const now = Date.now();
        const idleFor = now - lastAct;
        const elapsed = now - startedAt;
        if (elapsed < maxMs && idleFor < stallMs) return;
        const kind = elapsed >= maxMs ? 'cap' : 'stall';
        const err = new Error(kind === 'cap'
          ? `turn still running after ${fmtDur(elapsed)} (cap ${fmtDur(maxMs)})`
          : `no agent activity for ${fmtDur(idleFor)} (stall limit ${fmtDur(stallMs)})`);
        err.watchdog = kind;
        console.log(`[conversation] watchdog tripped (${kind}) chat=${chatId} session=${sessionId} model=${sel.provider}/${sel.model} idle=${Math.round(idleFor / 1000)}s elapsed=${Math.round(elapsed / 1000)}s`);
        this.agent.abort(sessionId).catch(() => {});
        this.agent.failTurn?.(sessionId, err);
        finish({ ok: false, err });
      }, checkMs);
      timer.unref?.();
    });
    if (!outcome.ok) throw outcome.err;
  }

  /** Settle-time text recovery (2026-11-01 live lesson): streamed SSE
   *  deltas were the ONLY path for assistant text, so any turn whose
   *  events never arrived (dead/half-open stream, wrong-instance
   *  subscription) ended "ok" with an empty accumulator — silence. At
   *  settle, fetch the session's stored messages and fold in every
   *  assistant text from THIS turn that was not already streamed
   *  (dedupe by messageID against the accumulator). Returns the count. */
  async recoverMissedText(chatId, sessionId, acc, turnStartMs) {
    if (!this.agent.sessionMessages) return 0;
    const msgs = await this.agent.sessionMessages(sessionId).catch(() => null);
    if (!msgs) return 0;
    let recovered = 0;
    for (const m of msgs) {
      if (m.role !== 'assistant' || !m.text?.trim()) continue;
      if (m.created && m.created < turnStartMs - 2000) continue; // earlier turns' history
      if (acc.byMsg.has(m.id)) continue; // already streamed
      acc.byMsg.set(m.id, m.text);
      if (!acc.order.includes(m.id)) acc.order.push(m.id);
      recovered += 1;
    }
    if (recovered) console.log(`[conversation] recovered ${recovered} assistant message(s) from the session store for chat ${chatId}`);
    return recovered;
  }

  async runTurn(chatId, text, { isNudge = false } = {}) {
    const cs = this.chatState(chatId);
    const gen = this.generations.get(chatId) || 0;
    const typing = setInterval(() => { this.tg.sendChatAction?.(chatId, 'typing'); }, 4000);
    typing.unref?.();
    this.tg.sendChatAction?.(chatId, 'typing');
    const outboxBefore = this.outbox ? this.outbox.arrivedCount : 0;
    const turnStartMs = Date.now();
    let acc = null;
    try {
      const { created } = await this.ensureSession(chatId);
      const sel = { ...this.selectionOf(cs) };
      this.currentTexts.set(chatId, text);
      this.relay?.attach(cs.sessionId, chatId, 'chat');
      acc = { chatId, gen, order: [], byMsg: new Map(), flushed: new Set(), current: null, chain: Promise.resolve(), sawEvent: false };
      this.acc.set(cs.sessionId, acc);
      const memoryBrief = created && !isNudge ? readMemoryBrief() : '';
      const firstText = created && !isNudge
        ? [memoryBrief, FIRST_TURN_PREFIX, text].filter(Boolean).join('\n')
        : text;

      let attemptText = firstText;
      let retried = false;
      let failure = null;
      for (;;) {
        try {
          console.log(`[conversation] prompt sent chat=${chatId} session=${cs.sessionId} model=${sel.provider}/${sel.model}${retried ? ' (retry)' : ''}`);
          await this.awaitPrompt(chatId, cs.sessionId,
            this.agent.prompt(cs.sessionId, attemptText, { providerID: sel.provider, modelID: sel.model }), sel);
          break;
        } catch (e) {
          if (e?.watchdog) { failure = e; break; } // watchdog: no guard retry — report it
          if (retried) { failure = e; break; }
          const action = await this.guardAction(chatId, e, sel).catch(ge => ({ failWith: ge }));
          if (!action) { failure = e; break; }
          if (action.failWith) { failure = action.failWith; break; }
          retried = true;
          attemptText = action.retryText ?? firstText;
          // The guard may have switched the standing selection / session.
          Object.assign(sel, this.selectionOf(cs));
          if (cs.sessionId) this.acc.set(cs.sessionId, acc); // re-key if the session was recreated
          this.relay?.attach(cs.sessionId, chatId, 'chat');
          // Fresh accumulator for the retry's text (keep the same acc —
          // the failed attempt may already have streamed real text; the
          // retry continues the same chat turn from the owner's view).
        }
      }

      if (failure) {
        console.log(`[conversation] turn finished chat=${chatId} outcome=failure (${String(failure.message || failure).slice(0, 120)})`);
        if (failure.watchdog) {
          const notice = failure.watchdog === 'cap'
            ? `⚠️ The model ${sel.provider} / ${sel.model} was still working after ${fmtDur(envFloat('TURN_MAX_MIN', 15) * 60000)} without finishing, so I stopped that turn. Nothing is stuck — send your message again, or switch the model with /model.`
            : `⚠️ The model ${sel.provider} / ${sel.model} stopped answering (no activity for ${fmtDur(envFloat('TURN_STALL_MIN', 3) * 60000)}), so I stopped that turn. Nothing is stuck — send your message again, or switch the model with /model.`;
          await this.tg.sendMessage(chatId, notice).catch(() => {});
        } else {
          const msg = String(failure.message || failure).slice(0, 700);
          await this.tg.sendMessage(chatId, `❌ The agent could not finish that: ${msg}`).catch(() => {});
        }
        return { ok: false };
      }

      // The waiter settled — recover any assistant text the event
      // stream missed BEFORE deciding the turn said nothing.
      const recovered = await this.recoverMissedText(chatId, cs.sessionId, acc, turnStartMs);
      this.flushAll(acc);
      await acc.chain; // let streamed + recovered messages land before follow-ups
      const streamedChars = this.joinedText(acc).length;
      console.log(`[conversation] waiter settled chat=${chatId} streamed=${streamedChars} chars recovered=${recovered} message(s)`);

      this.deathNoticeSent = false; // a healthy turn ends the death episode

      if (this.abortFlags.has(chatId)) {
        this.abortFlags.delete(chatId);
        console.log(`[conversation] turn finished chat=${chatId} outcome=aborted`);
        return { ok: true, aborted: true }; // no claim check on a stopped turn
      }

      let arrived = 0;
      if (this.outbox) {
        if (!isNudge) await sleep(this.settleMs); // let a just-written send_file request register
        arrived = this.outbox.arrivedCount - outboxBefore;
      }
      if (!isNudge && arrived === 0 && looksLikeDeliveryClaim(this.joinedText(acc))) {
        console.log(`[conversation] turn finished chat=${chatId} outcome=claim-without-delivery (nudging)`);
        return { ok: true, claimWithoutDelivery: true };
      }

      // A turn that ends with no text, no delivery and no pending ask
      // must never be silence — say so, plainly, once.
      if (!this.joinedText(acc).trim() && arrived === 0 && !this.relay?.hasPendingFor?.(cs.sessionId)) {
        console.log(`[conversation] turn finished chat=${chatId} outcome=empty (posting notice)`);
        await this.tg.sendMessage(chatId, 'ℹ️ That turn finished without any reply from the agent — odd, but nothing is stuck. Try sending that again.').catch(() => {});
        return { ok: true, empty: true };
      }
      console.log(`[conversation] turn finished chat=${chatId} outcome=ok`);
      return { ok: true };
    } catch (e) {
      // ensureSession failures land here (e.g. no working model): say it
      // in plain language, in chat — never a silent dead end.
      const msg = String(e.message || e).slice(0, 700);
      console.log(`[conversation] turn finished chat=${chatId} outcome=error (${msg.slice(0, 120)})`);
      await this.tg.sendMessage(chatId, `❌ ${msg}`).catch(() => {});
      return { ok: false };
    } finally {
      clearInterval(typing);
    }
  }

  // ── Guard classification + recovery for a failed turn ───────────────────
  // Returns { retryText } to retry once, { failWith } for a custom final
  // message, or null to surface the original error.
  async guardAction(chatId, e, sel) {
    const cs = this.chatState(chatId);
    const msg = e.message || '';

    // 1) The server itself died / is unreachable: respawn, re-attach,
    //    one restart notice, retry the same text once.
    if (isServerGoneError(e)) {
      try { await this.agent.ensure(); } catch { return null; }
      if (cs.sessionId && !(await this.agent.sessionExists(cs.sessionId))) {
        return this.sessionGoneAction(chatId);
      }
      await this.deathNotice(chatId);
      return { retryText: null }; // null retryText → caller reuses the original text
    }

    // 2) The persisted session is gone (server DB reset): start fresh,
    //    tell the owner plainly, retry once in the new session.
    if (/OpenCode POST \/session\/\S+ HTTP 404/.test(msg)) {
      return this.sessionGoneAction(chatId);
    }

    // 3) Token limit: the provider's whole free tier cannot fit a turn
    //    this size — switch to the OTHER provider's .env default (probed
    //    first; a switch to a dead model is no switch).
    if (isTokenLimitError(msg)) {
      const fromLabel = PROVIDERS[sel.provider]?.label || sel.provider;
      const other = sel.provider === 'groq' ? 'nvidia' : 'groq';
      const otherLabel = PROVIDERS[other]?.label || other;
      const target = PROVIDERS[other].defaultModel();
      const probe = await probeModel(other, target);
      if (!probe.ok) {
        return { failWith: new Error(`Both models are unavailable right now: ${fromLabel} hit its free token limit for a message this size, and the fallback ${otherLabel} model ${other}/${target} did not answer either (${probe.error}). Wait a little and try again, or switch the model with /model.`) };
      }
      this.setSelection(cs, { provider: other, model: target });
      await this.tg.sendMessage(chatId, `⚠️ ${fromLabel} hit its free token limit for a message this size — I switched the current model to ${other} / ${target} and I'm retrying. (You can change it any time with /model.)`).catch(() => {});
      return { retryText: `[Note: the previous model failed (token limit / TPM — ${msg.slice(0, 140)}); the standing model was switched to ${other}/${target}. Please continue the user's last request.]\n\n${this.lastUserText(chatId)}` };
    }

    // 4) Transient provider overload (503 / service_unavailable): the
    //    model is fine, the service is momentarily overloaded. Tell the
    //    owner once, wait out the spike, retry the SAME text once — no
    //    model switch. (Checked before the dead-model matcher, whose
    //    /model/i would otherwise swallow these payloads.)
    if (isTransientError(msg)) {
      const delaySec = envFloat('TRANSIENT_RETRY_DELAY_SEC', 20);
      console.log(`[conversation] transient overload chat=${chatId} — waiting ${delaySec}s, then one retry`);
      await this.tg.sendMessage(chatId, '⚠️ The model service is temporarily overloaded — retrying once…').catch(() => {});
      await sleep(delaySec * 1000);
      return { retryText: null }; // null retryText → caller reuses the original text
    }

    // 5) Dead model mid-turn (probe passed, turn still died of a model
    //    problem): re-resolve once, skipping the model that just failed.
    if (isDeadModelError(msg)) {
      const failed = `${sel.provider}/${sel.model}`;
      const notes = [];
      const res = await resolveWorkingModel(sel.provider, sel.model, t => notes.push(t), { skip: [failed] });
      if (!res.provider) {
        const detail = res.tried.map(t => `${t.provider}/${t.model} (${t.error || 'no response'})`).join('; ');
        return { failWith: new Error(`No working model found. Tried: ${detail}. Check the API keys in .env, or run: node scripts/check-models.mjs`) };
      }
      this.setSelection(cs, { provider: res.provider, model: res.model });
      await this.tg.sendMessage(chatId, `⚠️ The model ${failed} stopped answering (${msg.slice(0, 200)}) — I switched the current model to ${res.provider}/${res.model} and I'm retrying.`).catch(() => {});
      return { retryText: `[Note: the previous model failed (${msg.slice(0, 200)}); the standing model was switched to ${res.provider}/${res.model}. Please continue the user's last request.]\n\n${this.lastUserText(chatId)}` };
    }

    return null;
  }

  async sessionGoneAction(chatId) {
    const cs = this.chatState(chatId);
    cs.sessionId = null;
    this.saveState();
    await this.ensureSession(chatId);
    await this.tg.sendMessage(chatId, 'ℹ️ The earlier conversation could not be restored, so I started a fresh one — please repeat anything important from before.').catch(() => {});
    return { retryText: null };
  }

  /** The text of the turn currently being retried (set by runTurn). */
  lastUserText(chatId) {
    return this.currentTexts?.get(chatId) || '';
  }
}
