// Permission / question relay: when the OpenCode agent stops to ask for a
// permission or an answer, the owner gets it in Telegram as text + buttons
// — never a typed yes/no, and the job never stalls on an unseen prompt.
// Pending asks persist in data/pending.json so a bot restart mid-job does
// not lose them; on boot they are re-sent. Nothing is ever auto-approved:
// an unanswered ask simply waits (OpenCode itself pauses the turn); after
// 30 minutes the owner gets ONE reminder nudge.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { env, envInt, ROOT } from '../lib/env.mjs';
import { keyboard, rowsOf } from './telegram.mjs';

const DEFAULT_FILE = join(ROOT, 'data', 'pending.json');
const PERM_DECISION = {
  once: '✅ Your answer: Yes (this time only)',
  always: '♾️ Your answer: Always for this job',
  reject: '❌ Your answer: No',
};

/** Plain-English one-liners describing what a permission request touches. */
export function describePermission(p) {
  const md = p?.metadata || {};
  const bits = [];
  if (md.command) bits.push(`Command: ${md.command}`);
  for (const k of ['filepath', 'filePath', 'path', 'url']) if (md[k]) bits.push(`${k}: ${md[k]}`);
  if (!bits.length) for (const pat of p?.patterns || []) bits.push(String(pat));
  return bits;
}

export class AskRelay {
  constructor({ tg, agent, pendingFile = DEFAULT_FILE, remindAfterMs } = {}) {
    if (!tg || !agent) throw new Error('AskRelay needs { tg, agent }');
    this.tg = tg;
    this.agent = agent;
    this.file = pendingFile;
    this.remindAfterMs = remindAfterMs ?? envInt('ASK_REMIND_MIN', 30) * 60000;
    this.sessions = new Map(); // sessionId -> { chatId, jobId }
    this.pending = new Map();  // requestId -> entry (persisted)
    this.load();
    this.timer = null;
    this.pollTimer = null;
    this.offEvent = agent.onEvent ? agent.onEvent(ev => { this.onAgentEvent(ev).catch(() => {}); }) : null;
  }

  /** Route future asks of this session to this chat/job. Called by the
   *  processor before every prompt. */
  attach(sessionId, chatId, jobId) {
    if (sessionId && chatId) this.sessions.set(sessionId, { chatId, jobId });
  }

  load() {
    try {
      if (!existsSync(this.file)) return;
      for (const e of JSON.parse(readFileSync(this.file, 'utf8'))) this.pending.set(e.id, e);
    } catch { /* a corrupt file must never block the bot */ }
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify([...this.pending.values()], null, 2));
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.nudgeStale().catch(() => {}); }, 60000);
    this.timer.unref?.();
    // Poll backstop (2026-11-01 live lesson): asks were discovered ONLY
    // via SSE events — when the event stream delivers nothing (dead /
    // half-open / wrong-instance subscription), an ask never reaches
    // Telegram and the session waits for an answer forever. Poll the
    // server's pending lists and surface anything new through the same
    // path as the SSE handler (deduped by request id in `pending`).
    const pollSec = Math.max(1, envInt('ASK_POLL_SEC', 7));
    this.pollTimer = setInterval(() => { this.pollPending().catch(e => console.error('[relay] pending poll failed:', e.message)); }, pollSec * 1000);
    this.pollTimer.unref?.();
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.offEvent?.();
  }

  /** Is an ask (permission or question) pending for this session? The
   *  conversation watchdog uses this: a turn waiting on the OWNER's tap
   *  is not a stalled model. */
  hasPendingFor(sessionId) {
    for (const e of this.pending.values()) if (e.sessionId === sessionId) return true;
    return false;
  }

  /** Backstop sweep: fetch both pending lists and surface any ask for
   *  an attached session that the event stream never delivered. */
  async pollPending() {
    if (!this.sessions.size) return;
    const [perms, questions] = await Promise.all([
      this.agent.listPendingPermissions ? this.agent.listPendingPermissions().catch(() => []) : [],
      this.agent.listPendingQuestions ? this.agent.listPendingQuestions().catch(() => []) : [],
    ]);
    for (const p of perms || []) { if (p?.id && !this.pending.has(p.id)) await this.surfacePermission(p).catch(() => {}); }
    for (const q of questions || []) { if (q?.id && !this.pending.has(q.id)) await this.surfaceQuestion(q).catch(() => {}); }
  }

  // ── Event intake ─────────────────────────────────────────────────────────

  /** Surface one permission request (from the SSE handler or the poll
   *  backstop — identical handling, deduped by request id). */
  async surfacePermission(p) {
    const ctx = this.sessions.get(p.sessionID);
    if (!ctx || this.pending.has(p.id)) return; // not our session, or already shown
    const entry = {
      kind: 'perm', id: p.id, sessionId: p.sessionID,
      chatId: ctx.chatId, jobId: ctx.jobId,
      permission: p.permission || 'a tool', patterns: p.patterns || [],
      metadata: p.metadata || {}, askedAt: Date.now(), reminded: false, msgId: null,
    };
    this.pending.set(entry.id, entry);
    this.save();
    await this.sendPermission(entry);
  }

  /** Surface one question request (SSE handler or poll backstop). */
  async surfaceQuestion(p) {
    const ctx = this.sessions.get(p.sessionID);
    if (!ctx || this.pending.has(p.id)) return;
    const entry = {
      kind: 'ques', id: p.id, sessionId: p.sessionID,
      chatId: ctx.chatId, jobId: ctx.jobId,
      questions: p.questions || [], answers: [], index: 0,
      awaitingText: false, askedAt: Date.now(), reminded: false, msgId: null,
    };
    this.pending.set(entry.id, entry);
    this.save();
    await this.sendQuestion(entry);
  }

  async onAgentEvent(ev) {
    const p = ev.properties || ev.data || {};
    if (ev.type === 'permission.asked' && p.id) {
      await this.surfacePermission(p);
    } else if (ev.type === 'question.asked' && p.id) {
      await this.surfaceQuestion(p);
    } else if (ev.type === 'permission.replied' && p.requestID) {
      // Answered somewhere else (e.g. a re-sent duplicate) — stop showing it.
      if (this.pending.delete(p.requestID)) this.save();
    } else if (ev.type === 'question.replied' || ev.type === 'question.rejected') {
      const rid = p.requestID || p.id;
      if (rid && this.pending.delete(rid)) this.save();
    }
  }

  // ── Sending asks ─────────────────────────────────────────────────────────

  permissionText(e) {
    const details = describePermission(e).map(b => `• ${b}`).join('\n');
    return [
      `🔐 Permission needed — ${e.jobId}`,
      `The agent wants to use: ${e.permission}`,
      ...(details ? [details] : []),
      '',
      'The job is paused until you tap an answer.',
    ].join('\n').slice(0, 3500);
  }

  async sendPermission(entry) {
    entry.text = this.permissionText(entry);
    const msg = await this.tg.sendMessage(entry.chatId, entry.text, keyboard([
      [{ text: '✅ Yes', data: `perm:${entry.id}:once` }, { text: '❌ No', data: `perm:${entry.id}:reject` }],
      [{ text: '♾️ Always for this job', data: `perm:${entry.id}:always` }],
    ]));
    entry.msgId = msg.message_id;
    this.save();
  }

  questionText(e) {
    const q = e.questions[e.index] || {};
    const lines = [
      `❓ Question from the agent — ${e.jobId}` + (e.questions.length > 1 ? ` (${e.index + 1}/${e.questions.length})` : ''),
      q.question || '',
    ];
    for (const o of q.options || []) if (o.description) lines.push(`• ${o.label} — ${o.description}`);
    return lines.join('\n').slice(0, 3500);
  }

  async sendQuestion(entry) {
    const q = entry.questions[entry.index] || {};
    entry.text = this.questionText(entry);
    if ((q.options || []).length) {
      entry.awaitingText = false;
      const btns = q.options.map((o, i) => ({ text: o.label, data: `q:${entry.id}:${i}` }));
      const msg = await this.tg.sendMessage(entry.chatId, entry.text, keyboard(rowsOf(btns, 1)));
      entry.msgId = msg.message_id;
    } else {
      entry.awaitingText = true;
      const msg = await this.tg.sendMessage(entry.chatId, `${entry.text}\n\n✍️ Just reply with a text message — your reply is the answer.`);
      entry.msgId = msg.message_id;
    }
    this.save();
  }

  /** Re-send every persisted ask (bot restart mid-job). */
  async resendPending() {
    for (const e of this.pending.values()) {
      this.sessions.set(e.sessionId, { chatId: e.chatId, jobId: e.jobId });
      try {
        if (e.kind === 'perm') await this.sendPermission(e);
        else await this.sendQuestion(e);
      } catch { /* one bad chat must not block the others */ }
    }
  }

  // ── Answers ──────────────────────────────────────────────────────────────

  /** Is there a free-text question waiting for this chat? (bot routes the
   *  owner's next plain message here.) */
  pendingTextFor(chatId) {
    for (const e of this.pending.values()) {
      if (e.kind === 'ques' && e.chatId === chatId && e.awaitingText) return true;
    }
    return false;
  }

  async handleTextAnswer(chatId, text) {
    for (const e of this.pending.values()) {
      if (e.kind === 'ques' && e.chatId === chatId && e.awaitingText) {
        await this.recordAnswer(e, String(text).trim());
        return true;
      }
    }
    return false;
  }

  /** Route a perm:/q: callback tap. Returns true if it was one of ours. */
  async handleCallback(chatId, data) {
    if (data.startsWith('perm:')) {
      const [, id, choice] = data.split(':');
      const e = this.pending.get(id);
      if (!e || e.kind !== 'perm' || !PERM_DECISION[choice]) return false;
      this.pending.delete(id);
      this.save();
      try {
        await this.agent.replyPermission(e.sessionId, id, choice);
        await this.tg.editMessageText(chatId, e.msgId, `${e.text}\n\n${PERM_DECISION[choice]}`).catch(() => {});
      } catch {
        await this.tg.editMessageText(chatId, e.msgId, `${e.text}\n\n⚠️ This request is no longer active on the agent (the session may have been restarted) — your tap could not be delivered.`).catch(() => {});
      }
      return true;
    }
    if (data.startsWith('q:')) {
      const [, id, idx] = data.split(':');
      const e = this.pending.get(id);
      if (!e || e.kind !== 'ques') return false;
      const opt = (e.questions[e.index]?.options || [])[Number(idx)];
      if (!opt) return false;
      await this.recordAnswer(e, opt.label);
      return true;
    }
    return false;
  }

  async recordAnswer(entry, label) {
    entry.answers[entry.index] = [label];
    // Show the chosen answer on the question message itself.
    await this.tg.editMessageText(entry.chatId, entry.msgId, `${entry.text}\n\n✅ Your answer: ${label}`).catch(() => {});
    entry.index += 1;
    entry.awaitingText = false;
    if (entry.index < entry.questions.length) { this.save(); await this.sendQuestion(entry); return; }
    this.pending.delete(entry.id);
    this.save();
    try {
      await this.agent.replyQuestion(entry.id, entry.answers, entry.sessionId);
    } catch {
      await this.tg.sendMessage(entry.chatId, `⚠️ Your answer to ${entry.jobId} could not be delivered — the question is no longer active on the agent.`).catch(() => {});
    }
  }

  /** One reminder, 30 min in, for anything still unanswered. No auto-answer,
   *  ever. */
  async nudgeStale() {
    const now = Date.now();
    for (const e of this.pending.values()) {
      if (e.reminded || now - e.askedAt < this.remindAfterMs) continue;
      e.reminded = true;
      this.save();
      await this.tg.sendMessage(e.chatId, `⏰ Still waiting for your answer — job ${e.jobId} is paused on the ${e.kind === 'perm' ? 'permission request' : 'question'} above.`).catch(() => {});
    }
  }
}
