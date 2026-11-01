// OpenCode serve-mode driver.
//
// Built against the API of the INSTALLED OpenCode 1.19.5, verified live on
// 2026-11-01 by starting `opencode serve` in a scratch dir and reading its
// OpenAPI doc (GET /doc) + smoke-testing the endpoints. The shapes used:
//
//   POST /session                      -> 200 Session { id: "ses_...", ... }
//        body: { title?, agent?, model?: { id, providerID } }
//   POST /session/{id}/prompt_async    -> 204 (turn runs in the background)
//        body: { parts: [{ type: "text", text }], agent?, model?: { providerID, modelID } }
//   GET  /event                        -> SSE stream; each block is
//        `data: {"id":"evt_...","type":<type>,"properties":{...}}`
//        event types used here:
//          permission.asked   properties: PermissionRequest { id: "per_...",
//                             sessionID, permission, patterns[], metadata{},
//                             always[], tool { messageID, callID } }
//          question.asked     properties: QuestionRequest { id: "que_...",
//                             sessionID, questions: [{ question, header,
//                             options: [{ label, description }], multiple?,
//                             custom? }], tool }
//          permission.replied properties: { sessionID, requestID, reply }
//          session.idle       properties: { sessionID }
//          session.error      properties: { sessionID?, error }
//          message.part.delta properties: { sessionID, messageID, partID,
//                             field, delta }   (field "text" = assistant text)
//   POST /session/{id}/permissions/{requestID}   body { response:
//        "once" | "always" | "reject" }              -> 200 true
//   POST /question/{requestID}/reply   body { answers: [[label, ...], ...] }
//        (one array of chosen labels per question)  -> 200 true
//   POST /question/{requestID}/reject              -> 200 true
//   GET  /permission , GET /question   -> pending PermissionRequest[] /
//                                         QuestionRequest[]
//   GET  /session/status               -> { [sessionID]: { type } } — idle
//        sessions are ABSENT from the map (verified live).
//   POST /session/{id}/abort
//   POST /session?directory=<abs path> — the directory is a QUERY param
//        (verified live against 1.19.5, 2026-11-01): the created session
//        is rooted at that directory (Session.directory) even though the
//        server process itself runs elsewhere. The conversation session
//        uses this to live at the REPO ROOT while the server keeps its
//        core/ cwd (the custom tools resolve media/ from that cwd).
//   GET  /session/{id}/message         -> [{ info: { id, role, ... },
//        parts: [{ type: "text", text, messageID, ... }] }] — the
//        recovery source for assistant text when the event stream
//        missed it (see Conversation's settle-time fetch).
//   GET  /global/event                 -> SSE of ALL instances' events,
//        each block wrapped: { directory, project, payload: <the v1
//        event> } (plus payload.type "sync" bookkeeping events, which
//        are not v1 events and are skipped).
//
// DIRECTORY SCOPING (root cause of the 2026-11-01 live silence):
// /event, /session/status, /question and /permission are all scoped to
// ONE project instance — the one matching the request's ?directory=
// (the server cwd's instance when omitted). A session created with
// ?directory=<repo root> is INVISIBLE to the no-directory variants: no
// deltas, no asks, no idle on /event, and /session/status reports {}
// while the session is in fact busy. Verified live against 1.19.5 with
// a mock provider (2026-11-01): the events flow on /global/event and on
// /event?directory=<dir>; the status shows busy/retry only with
// ?directory=. This driver therefore (a) ALSO subscribes to
// /global/event and unwraps payloads (deduped by event id against the
// plain stream), and (b) merges ?directory= status/list reads for every
// directory it has created sessions in.
//
// One server child process is spawned lazily (cwd = core/, exactly like the
// `opencode run` driver sees the project) and reused across all jobs.
// If the managed child exits unexpectedly, pending turn waiters are failed
// with a `serverDied` error and onServerExit listeners fire — the next
// ensure() call respawns the server, and OpenCode's on-disk sessions
// survive the restart, so a conversation can re-attach by session id.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { env, envInt, ROOT } from '../lib/env.mjs';
import { binaryExists } from '../lib/run.mjs';

const CORE = join(ROOT, 'core');
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class AgentServer {
  constructor({ baseUrl, onEvent } = {}) {
    const fromEnv = env('OPENCODE_SERVER_URL', '');
    this.baseUrl = (baseUrl || fromEnv || `http://127.0.0.1:${envInt('OPENCODE_PORT', 4096)}`).replace(/\/$/, '');
    // We spawn the server ourselves only when the URL is the default local
    // one (tests inject their own baseUrl and run their own mock server).
    this.managed = !baseUrl && !fromEnv;
    this.child = null;
    this.starting = null;
    this.stopped = false;
    this.listeners = new Set();
    if (onEvent) this.listeners.add(onEvent);
    this.waiters = new Map();   // sessionId -> Set<{resolve, reject, timer, cancel}>
    this.progress = new Map();  // sessionId -> onProgress(text) callback
    this.textBuf = new Map();   // sessionId -> recent assistant text
    this.streamCtl = new Map(); // 'event'|'global' -> current attempt's AbortController
    this.streamLoops = new Set(); // 'event'|'global' with a live reconnect loop
    this.streamUp = new Map();  // 'event'|'global' -> bool (connected now)
    this.sseConnected = false;  // at least one event stream is connected
    this.lastEventAt = 0;       // last event received on ANY stream (liveness)
    this.seenEvents = new Set();// recent event ids (cross-stream dedupe)
    this.activity = new Map();  // sessionId -> last event time (watchdog)
    this.sessionDirs = new Map(); // sessionId -> directory it lives in
    this.livenessTimer = null;  // SSE half-open supervisor
    this.deathListeners = new Set(); // fn({code, signal}) on unexpected child exit
  }

  /** Subscribe to ALL server events. Returns an unsubscribe function. */
  onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** Subscribe to unexpected exits of the MANAGED server child (never
   *  fires for stop() or for externally-run servers). Returns unsubscribe. */
  onServerExit(fn) { this.deathListeners.add(fn); return () => this.deathListeners.delete(fn); }

  /** Progress text callback for one session (assistant text, tail slice). */
  setProgress(sessionId, fn) {
    if (fn) this.progress.set(sessionId, fn); else this.progress.delete(sessionId);
  }

  async healthy() {
    try {
      const r = await fetch(`${this.baseUrl}/session/status`, { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch { return false; }
  }

  /** Make sure the server is up (spawning it if we manage it) and the event
   *  stream is connected. Safe to call before every operation. */
  async ensure() {
    this.startLiveness();
    if (await this.healthy()) { this.connectEvents(); await this.waitSse(); return; }
    if (!this.managed) throw new Error(`OpenCode server at ${this.baseUrl} is not reachable.`);
    if (!this.starting) this.starting = this.spawnServer().finally(() => { this.starting = null; });
    await this.starting;
    this.connectEvents();
    await this.waitSse();
  }

  /** SSE half-open supervisor: a silently dead stream (no data, no
   *  error — e.g. a proxy that stopped forwarding) leaves reader.read()
   *  blocked forever and sseConnected stale-true. While any turn waiter
   *  is active, a stream silent for SSE_STALE_SEC (default 90) is
   *  aborted and reconnected by its own loop. Every event on any stream
   *  counts as life. */
  startLiveness() {
    if (this.livenessTimer) return;
    this.livenessTimer = setInterval(() => {
      if (this.stopped) return;
      const waitersActive = [...this.waiters.values()].some(s => s.size);
      if (!waitersActive) return;
      const staleMs = envInt('SSE_STALE_SEC', 90) * 1000;
      if (Date.now() - (this.lastEventAt || 0) <= staleMs) return;
      console.log(`[agent-server] event streams silent for >${envInt('SSE_STALE_SEC', 90)}s during an active turn — forcing reconnect`);
      this.lastEventAt = Date.now(); // don't re-trip while reconnecting
      for (const ctl of this.streamCtl.values()) { try { ctl.abort(); } catch { /* loop reconnects */ } }
    }, 5000);
    this.livenessTimer.unref?.();
  }

  /** Bounded wait for the SSE stream to (re)connect. A prompt sent while
   *  the stream is down LOSES its streamed text (events are not replayed),
   *  which after a respawn is a real window (~1.5 s reconnect backoff).
   *  Best-effort: after ~3 s we proceed anyway — the waiter's status
   *  backstop still completes the turn, just without streamed text. */
  async waitSse(ms = 3000) {
    const t0 = Date.now();
    while (!this.sseConnected && !this.stopped && Date.now() - t0 < ms) await sleep(100);
  }

  async spawnServer() {
    const bin = env('OPENCODE_BIN', 'opencode');
    if (!binaryExists(bin)) {
      throw new Error(`OpenCode binary "${bin}" not found — run deploy/setup.sh on the VPS, or fix OPENCODE_BIN in .env.`);
    }
    const port = new URL(this.baseUrl).port || '4096';
    this.child = spawn(bin, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
      cwd: CORE, env: process.env, stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.child.stderr.on('data', d => process.stderr.write(`[opencode] ${d}`));
    this.child.on('exit', (code, signal) => {
      this.child = null;
      if (this.stopped) return; // our own stop() — not a death
      // The server died mid-flight: any turn waiting on it can never
      // complete (its events are gone), so fail those waiters NOW with a
      // recognisable error instead of letting them hang to the turn
      // timeout, and tell subscribers so they can respawn + notify.
      const err = new Error(`OpenCode server process exited (code ${code ?? '?'}, signal ${signal ?? 'none'})`);
      err.serverDied = true;
      for (const sid of [...this.waiters.keys()]) this.failWaiters(sid, err);
      for (const fn of this.deathListeners) { try { fn({ code, signal }); } catch { /* listener errors are contained */ } }
    });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (await this.healthy()) return;
      await sleep(400);
    }
    throw new Error('OpenCode server did not start within 30 s.');
  }

  connectEvents() {
    this.connectStream('event');
    this.connectStream('global');
  }

  /** One SSE subscription with its own reconnect loop. Two streams are
   *  kept: the plain /event (scoped to the server cwd's instance — the
   *  only one the test fakes implement) and /global/event (every
   *  instance, wrapped in { directory, payload }). Events are deduped
   *  by id across both, so an event visible on both arrives once. */
  connectStream(kind) {
    if (this.streamLoops.has(kind) || this.stopped) return;
    this.streamLoops.add(kind);
    const path = kind === 'global' ? '/global/event' : '/event';
    (async () => {
      while (!this.stopped) {
        // Fresh controller per attempt: the liveness supervisor aborts
        // the CURRENT one to force a reconnect, and the next attempt
        // must not inherit the aborted signal.
        const ctl = new AbortController();
        this.streamCtl.set(kind, ctl);
        let wasUp = false;
        try {
          const res = await fetch(`${this.baseUrl}${path}`, { signal: ctl.signal, headers: { Accept: 'text/event-stream' } });
          if (!res.ok || !res.body) throw new Error(`event stream HTTP ${res.status}`);
          wasUp = true;
          this.streamUp.set(kind, true);
          this.sseConnected = true;
          this.lastEventAt = Date.now();
          console.log(`[agent-server] event stream connected (${kind})`);
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i); buf = buf.slice(i + 2);
              const line = block.split('\n').find(l => l.startsWith('data:'));
              if (!line) continue;
              let raw; try { raw = JSON.parse(line.slice(5).trim()); } catch { continue; }
              this.lastEventAt = Date.now(); // any bytes = the stream is alive
              let ev = raw;
              if (kind === 'global') {
                ev = raw?.payload;
                // "sync" payloads are durable-store bookkeeping, not v1
                // events; anything without a v1 type is not dispatchable.
                if (!ev || typeof ev.type !== 'string' || ev.type === 'sync') continue;
              }
              if (ev.id) {
                if (this.seenEvents.has(ev.id)) continue; // same event on both streams
                this.seenEvents.add(ev.id);
                if (this.seenEvents.size > 2000) { // bounded: drop the oldest half
                  const keep = [...this.seenEvents].slice(-1000);
                  this.seenEvents = new Set(keep);
                }
              }
              this.dispatch(ev);
            }
          }
        } catch { if (this.stopped) break; }
        this.streamUp.set(kind, false);
        this.sseConnected = !![...this.streamUp.values()].find(Boolean);
        if (!this.stopped) {
          if (wasUp) console.log(`[agent-server] event stream disconnected (${kind}) — reconnecting`);
          await sleep(1500); // reconnect backoff
        }
      }
      this.streamLoops.delete(kind);
      this.streamCtl.delete(kind);
    })();
  }

  dispatch(ev) {
    // v1 events carry `properties`; some durable variants carry `data`.
    const props = ev.properties || ev.data || {};
    const sid = props.sessionID;
    if (sid) {
      this.activity.set(sid, Date.now()); // watchdog liveness per session
      if (ev.type === 'session.idle') this.settleIdle(sid);
      if (ev.type === 'session.error') {
        const msg = props.error?.data?.message || props.error?.name || 'unknown error';
        this.failWaiters(sid, new Error(`OpenCode session error: ${msg}`));
      }
      if (ev.type === 'message.part.delta' && props.field === 'text') {
        const cb = this.progress.get(sid);
        if (cb) {
          const t = ((this.textBuf.get(sid) || '') + (props.delta || '')).slice(-4000);
          this.textBuf.set(sid, t);
          try { cb(t.slice(-300)); } catch { /* caller progress is best-effort */ }
        }
      }
    }
    for (const fn of this.listeners) { try { fn(ev); } catch { /* listener errors never kill the stream */ } }
  }

  /** Remember which directory a session lives in (its events/status
   *  are scoped to that project instance on the server). */
  trackDirectory(sessionId, directory) {
    if (sessionId && directory) this.sessionDirs.set(sessionId, directory);
  }

  directoryFor(sessionId) { return this.sessionDirs.get(sessionId); }

  /** Merged session-status map across every instance we know about:
   *  the no-directory map only covers the server cwd's project, so
   *  sessions living in another directory are merged in from their own
   *  ?directory= map (see the directory-scoping note at the top). */
  async statusMap() {
    const merged = {};
    const grab = async suffix => {
      try {
        const r = await fetch(`${this.baseUrl}/session/status${suffix}`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) Object.assign(merged, await r.json());
      } catch { /* one scope failing must not blind the others */ }
    };
    await grab('');
    const dirs = [...new Set(this.sessionDirs.values())];
    for (const d of dirs) await grab(`?directory=${encodeURIComponent(d)}`);
    return merged;
  }

  /** Is the server reporting this session as actively working? */
  async sessionBusy(sessionId) {
    const map = await this.statusMap();
    const st = map?.[sessionId];
    return !!(st && st.type && st.type !== 'idle');
  }

  /** Last SSE activity time for a session (0 = none seen). The
   *  conversation watchdog treats a turn with no activity as stalled. */
  lastActivityAt(sessionId) { return this.activity.get(sessionId) || 0; }

  /** Fail a session's pending turn waiters right now (watchdog abort). */
  failTurn(sessionId, err) { this.failWaiters(sessionId, err); }

  /** The session's stored messages, normalised to
   *  [{ id, role, text, created }] — the recovery source for assistant
   *  text the event stream missed. Returns null when the read fails. */
  async sessionMessages(sessionId) {
    try {
      const dir = this.sessionDirs.get(sessionId);
      const suffix = dir ? `?directory=${encodeURIComponent(dir)}` : '';
      const r = await fetch(`${this.baseUrl}/session/${sessionId}/message${suffix}`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return null;
      const list = await r.json();
      if (!Array.isArray(list)) return null;
      return list.map(m => ({
        id: m?.info?.id,
        role: m?.info?.role,
        created: m?.info?.time?.created || 0,
        text: (m?.parts || []).filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join(''),
      })).filter(m => m.id);
    } catch { return null; }
  }

  addWaiter(sessionId, timeoutMs) {
    let entry;
    const promise = new Promise((resolve, reject) => {
      entry = { resolve, reject, timer: null, cancel: null, poll: null };
    });
    entry.cancel = () => {
      const set = this.waiters.get(sessionId);
      if (set) { set.delete(entry); if (!set.size) this.waiters.delete(sessionId); }
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.poll) clearInterval(entry.poll);
    };
    if (timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        entry.cancel();
        this.abort(sessionId).catch(() => {});
        entry.reject(new Error(`OpenCode turn timed out after ${Math.round(timeoutMs / 60000)} min.`));
      }, timeoutMs);
    }
    // Status-poll BACKSTOP: the session.idle EVENT is the primary signal,
    // but an event emitted while our SSE stream is briefly disconnected
    // (e.g. during a server respawn) would otherwise hang this waiter
    // until the turn timeout. Poll the status endpoint: busy→idle means
    // the turn ended; never-busy for 5 s after the prompt was accepted
    // means it finished before we could observe it.
    entry.startedAt = Date.now();
    entry.sawBusy = false;
    entry.poll = setInterval(async () => {
      try {
        if (await this.sessionBusy(sessionId)) { entry.sawBusy = true; return; }
        if (entry.sawBusy || Date.now() - entry.startedAt > 5000) this.settleIdle(sessionId);
      } catch { /* status hiccup — the event path remains primary */ }
    }, 900);
    entry.poll.unref?.();
    if (!this.waiters.has(sessionId)) this.waiters.set(sessionId, new Set());
    this.waiters.get(sessionId).add(entry);
    return { promise, cancel: entry.cancel };
  }

  async settleIdle(sessionId) {
    // Snapshot the waiters THIS idle observation applies to, BEFORE the
    // async status check: a turn that fails fast (e.g. a TPM error) is
    // retried by the bridge within milliseconds, registering a NEW
    // waiter for the same session — the previous turn's stray idle must
    // never resolve it (it would end the retry with an empty result).
    const atCall = this.waiters.get(sessionId);
    if (!atCall || !atCall.size) return;
    const snapshot = [...atCall];
    // Belt-and-braces: ignore a stray idle while the server still reports
    // the session busy (e.g. an idle from a previous turn racing ours).
    // The check must use the MERGED map — the plain one cannot see a
    // directory-scoped session's busy state at all.
    try {
      const map = await this.statusMap();
      const st = map?.[sessionId];
      if (st && st.type && st.type !== 'idle') return;
    } catch { /* status check is advisory — resolve anyway */ }
    const current = this.waiters.get(sessionId);
    if (!current) return;
    for (const w of snapshot) {
      if (!current.has(w)) continue; // already settled/failed elsewhere
      current.delete(w);
      if (w.timer) clearTimeout(w.timer);
      if (w.poll) clearInterval(w.poll);
      w.resolve();
    }
    if (!current.size) this.waiters.delete(sessionId);
  }

  failWaiters(sessionId, err) {
    const set = this.waiters.get(sessionId);
    if (!set) return;
    this.waiters.delete(sessionId);
    for (const w of set) { if (w.timer) clearTimeout(w.timer); if (w.poll) clearInterval(w.poll); w.reject(err); }
  }

  async post(path, body) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) throw new Error(`OpenCode POST ${path} HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    return res;
  }

  async createSession({ providerID, modelID, agent = 'video-maker', title, directory } = {}) {
    await this.ensure();
    const body = { agent };
    if (title) body.title = title;
    if (providerID && modelID) body.model = { id: modelID, providerID };
    // `directory` is a query param (verified live on 1.19.5): the session
    // is rooted there — its files, bash and instructions resolve against
    // it — while the server process keeps its own cwd.
    const path = directory ? `/session?directory=${encodeURIComponent(directory)}` : '/session';
    const res = await this.post(path, body);
    const s = await res.json();
    if (!s?.id) throw new Error('OpenCode session create returned no id.');
    if (directory) this.trackDirectory(s.id, directory);
    return s.id;
  }

  /** Does this session still exist on the server? (Sessions persist on
   *  disk across server restarts; a false here means it is really gone.) */
  async sessionExists(sessionId) {
    try {
      const r = await fetch(`${this.baseUrl}/session/${sessionId}`, { signal: AbortSignal.timeout(3000) });
      return r.ok;
    } catch { return false; }
  }

  /** Send one user turn and wait until the session goes idle (the agent may
   *  pause on permission/question asks — the turn only completes after they
   *  are answered, which is exactly the relay's job). */
  async prompt(sessionId, text, { providerID, modelID, agent = 'video-maker' } = {}) {
    await this.ensure();
    this.activity.set(sessionId, Date.now()); // sending counts as activity
    this.textBuf.set(sessionId, '');
    const timeoutMs = envInt('OPENCODE_TIMEOUT_MIN', 120) * 60000;
    const w = this.addWaiter(sessionId, timeoutMs);
    const body = { parts: [{ type: 'text', text }], agent };
    if (providerID && modelID) body.model = { providerID, modelID };
    try {
      await this.post(`/session/${sessionId}/prompt_async`, body);
    } catch (e) { w.cancel(); throw e; }
    return w.promise;
  }

  /** reply: "once" | "always" | "reject" (v1 session permissions endpoint). */
  async replyPermission(sessionId, requestId, reply) {
    const dir = this.sessionDirs.get(sessionId);
    const suffix = dir ? `?directory=${encodeURIComponent(dir)}` : '';
    await this.post(`/session/${sessionId}/permissions/${requestId}${suffix}`, { response: reply });
    return true;
  }

  /** answers: one array of chosen labels per question, in order. */
  async replyQuestion(requestId, answers, sessionId = null) {
    const dir = sessionId ? this.sessionDirs.get(sessionId) : null;
    const suffix = dir ? `?directory=${encodeURIComponent(dir)}` : '';
    await this.post(`/question/${requestId}/reply${suffix}`, { answers });
    return true;
  }

  async rejectQuestion(requestId, sessionId = null) {
    const dir = sessionId ? this.sessionDirs.get(sessionId) : null;
    const suffix = dir ? `?directory=${encodeURIComponent(dir)}` : '';
    await this.post(`/question/${requestId}/reject${suffix}`, {});
    return true;
  }

  /** Pending asks merged across instances (plain + every known
   *  ?directory= scope), deduped by request id — the plain list alone
   *  cannot see asks from directory-scoped sessions. */
  async listMerged(path) {
    const out = new Map();
    const grab = async suffix => {
      const r = await fetch(`${this.baseUrl}${path}${suffix}`);
      if (!r.ok) throw new Error(`OpenCode GET ${path} HTTP ${r.status}`);
      const list = await r.json();
      if (Array.isArray(list)) for (const item of list) if (item?.id) out.set(item.id, item);
    };
    await grab('');
    for (const d of [...new Set(this.sessionDirs.values())]) {
      try { await grab(`?directory=${encodeURIComponent(d)}`); } catch { /* one scope failing must not hide the others */ }
    }
    return [...out.values()];
  }

  async listPendingPermissions() { return this.listMerged('/permission'); }

  async listPendingQuestions() { return this.listMerged('/question'); }

  async abort(sessionId) {
    await this.post(`/session/${sessionId}/abort`, {});
    return true;
  }

  stop() {
    this.stopped = true;
    if (this.livenessTimer) { clearInterval(this.livenessTimer); this.livenessTimer = null; }
    for (const ctl of this.streamCtl.values()) { try { ctl.abort(); } catch { /* already gone */ } }
    if (this.child) { try { this.child.kill('SIGTERM'); } catch { /* already dead */ } this.child = null; }
  }
}

/** Shared singleton used by the processor and the relay. */
export const agentServer = new AgentServer();
