// autoresume group — job auto-resume (FIX C).
//
// Live 2026-11-02: the paper-boat job DIED mid-work when the model
// stalled for 3 minutes; the watchdog killed the turn and told the
// owner to resend by hand. The owner called that THE problem: a whole
// video job runs as turns on one session, so one hung model call must
// not kill the job. Now: while a JOB is active (opened by a
// 🎬-composed brief; closed by the final delivery, /new or /cancel),
// a turn that dies of a stall or a transient/model error is restarted
// by the bridge itself with RESUME_TEXT — up to AUTO_RESUME_MAX (3)
// restarts per job, ONE owner notice on the first restart, then the
// existing plain failure. Plain chat turns keep the old behavior.
//
// Driven through the REAL AgentServer + Conversation classes against
// one mock HTTP server (providers + OpenCode), same harness shape as
// transient503.test.mjs. The mock's prompt behavior is scripted:
// 'stall' (never answers → the watchdog trips), 'ok' (one reply +
// idle), 'fail503' (the exact live overload payload on every attempt).
import { createServer } from 'node:http';

process.env.GROQ_API_KEY = 'gsk_resume_test';
process.env.NVIDIA_API_KEY = 'nvapi_resume_test';
process.env.DEFAULT_PROVIDER = 'nvidia';
process.env.GROQ_DEFAULT_MODEL = 'openai/gpt-oss-120b';
process.env.NVIDIA_DEFAULT_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
process.env.MODEL_PROBE = 'on';
process.env.OPENCODE_DRIVER = 'serve';
process.env.OPENCODE_TIMEOUT_MIN = '1';
process.env.TRANSIENT_RETRY_DELAY_SEC = '0.2';
process.env.TURN_STALL_MIN = '0.03'; // 1.8 s — the watchdog trips fast here
process.env.TURN_MAX_MIN = '2';
process.env.AUTO_RESUME_MAX = '3';

const LIVE_503 = '{"message":"Service temporarily overloaded","type":"service_unavailable","code":503}';
const BRIEF = [
  '[New video job — choices already made by the owner, do not ask about them again]',
  'Topic: How to make a paper boat, step by step',
  'Style: paper-cutout',
  'Aspect: 9:16',
  'Voice: TTS narration',
  'Narration language: same as the topic (unless the owner said otherwise).',
  'Make the video end to end.',
].join('\n');

const seen = { prompts: [] };
let sessionSeq = 0;
let eventRes = null;
let onPrimary = 'ok'; // behavior for ordinary prompts
let onResume = 'ok';  // behavior for bridge resume prompts
let okText = 'Done — next step finished.';

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const readBody = cb => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => cb(Buffer.concat(c).toString())); };
  const emit = ev => { try { eventRes?.write('data: ' + JSON.stringify(ev) + '\n\n'); } catch {} };

  if (p.endsWith('/chat/completions')) {
    return readBody(() => json(200, { choices: [{ message: { content: 'ok' } }] }));
  }
  if (p === '/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    if (res.flushHeaders) res.flushHeaders();
    eventRes = res;
    return;
  }
  if (p === '/global/health') return json(200, { healthy: true, version: 'mock' });
  if (p === '/session/status') return json(200, {});
  if (p === '/session' && req.method === 'POST') {
    return readBody(() => json(200, { id: `ses_r${++sessionSeq}`, slug: 'x', title: 'test', time: { created: 1, updated: 1 } }));
  }
  if (/^\/session\/[^/]+$/.test(p) && req.method === 'GET') return json(200, { id: p.split('/')[2] });
  if (p.includes('/prompt_async')) {
    return readBody(b => {
      const body = JSON.parse(b || '{}');
      const sid = p.split('/')[2];
      seen.prompts.push({ sid, body });
      json(204, {});
      const text = (body.parts || []).map(x => x.text || '').join('\n');
      const behavior = text.includes('Continue the video job from where you stopped') ? onResume : onPrimary;
      const n = seen.prompts.length;
      setTimeout(() => {
        if (behavior === 'ok') {
          emit({ type: 'message.part.delta', properties: { sessionID: sid, messageID: `msg_r${n}`, partID: 'p1', field: 'text', delta: okText } });
          emit({ type: 'session.idle', properties: { sessionID: sid } });
        } else if (behavior === 'fail503') {
          emit({ type: 'session.error', properties: { sessionID: sid, error: { name: 'UnknownError', data: { message: LIVE_503 } } } });
        }
        // 'stall' → nothing is ever emitted; the turn hangs until the watchdog trips.
      }, 40);
    });
  }
  if (p.includes('/abort')) return json(200, true);
  json(404, { error: { message: 'nf ' + p } });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
process.env.GROQ_BASE_URL = `http://127.0.0.1:${port}/groq`;
process.env.NVIDIA_BASE_URL = `http://127.0.0.1:${port}/nvidia`;
process.env.OPENCODE_SERVER_URL = `http://127.0.0.1:${port}`;

const { AgentServer } = await import('../bot/agent-server.mjs');
const { Conversation, RESUME_TEXT, RESUME_NOTICE } = await import('../bot/conversation.mjs');

const tgLog = { sent: [] };
const tg = {
  sendMessage: async (chatId, text) => { tgLog.sent.push({ chatId, text }); return { message_id: tgLog.sent.length }; },
  sendChatAction: async () => true,
};
const textsFor = id => tgLog.sent.filter(m => m.chatId === id).map(m => m.text);
const promptText = b => (b.parts || []).map(x => x.text || '').join('\n');

const state = {};
const chatState = id => (state[id] ||= { step: 'idle' });
const conv = new Conversation({
  tg, agent: new AgentServer(),
  chatState, saveState: () => {},
  selectionOf: cs => (cs.selection ??= { provider: 'nvidia', model: 'nvidia/nemotron-3-ultra-550b-a55b' }),
  setSelection: (cs, sel) => { cs.selection = { ...sel }; },
  sessionDirectory: '/tmp',
  settleMs: 50,
  outbox: { arrivedCount: 0 },
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, what, ms = 45000) {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await sleep(60); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

// ── (1) stall during an active job → bridge resumes it, owner does nothing
onPrimary = 'stall'; onResume = 'ok'; okText = 'Resumed and finished the next step.';
let before = seen.prompts.length;
await conv.submit(777, BRIEF);
await waitFor(() => textsFor(777).includes('Resumed and finished the next step.'), '(1) resume turn reply delivered');
{
  const mine = seen.prompts.slice(before);
  assert(mine.length === 2, `(1) original + exactly one resume prompt, got ${mine.length}`);
  assert(promptText(mine[1].body) === RESUME_TEXT, '(1) the resume prompt is the bridge resume text, verbatim');
  assert(textsFor(777).filter(t => t === RESUME_NOTICE).length === 1, '(1) exactly one auto-resume notice');
  assert(!textsFor(777).some(t => t.includes('stopped answering')), '(1) no stall failure message reached the owner');
  assert(!textsFor(777).some(t => t.startsWith('❌')), '(1) no failure message at all');
  assert(state[777].job?.active === true && state[777].job.resumes === 1, '(1) job still active, one resume consumed');
}
console.log('  ✓ (1) job stall → auto-resume on the same session, one notice, reply delivered');

// ── (2) the final delivery closes the job → a later stall is NOT resumed ──
onPrimary = 'ok'; onResume = 'ok'; okText = 'Working on it.';
await conv.submit(778, BRIEF);
await waitFor(() => textsFor(778).includes('Working on it.'), '(2) job turn reply');
assert(state[778].job?.active === true, '(2) job active after the brief');
conv.completeCurrentSession(778); // exactly what bot.mjs calls when a final=true delivery lands
assert(!state[778].job?.active, '(2) the final delivery closed the job');
onPrimary = 'stall';
before = seen.prompts.length;
await conv.submit(778, 'a plain follow-up question');
await waitFor(() => textsFor(778).some(t => t.includes('stopped answering')), '(2) plain stall notice once the job is closed');
await sleep(2500);
assert(seen.prompts.length - before === 1, '(2) no resume prompt after the job closed');
assert(!textsFor(778).some(t => t === RESUME_NOTICE), '(2) no auto-resume notice after the job closed');
console.log('  ✓ (2) final delivery closes the job; later stalls fall back to the plain notice, no resume');

// ── (3) plain chat stall → no resume, today's behavior exactly ────────────
onPrimary = 'stall';
before = seen.prompts.length;
await conv.submit(779, 'hello, just chatting');
await waitFor(() => textsFor(779).some(t => t.includes('stopped answering')), '(3) plain stall notice');
await sleep(2500);
assert(seen.prompts.length - before === 1, '(3) exactly one prompt — no resume for plain chat');
assert(!textsFor(779).some(t => t === RESUME_NOTICE), '(3) no auto-resume notice for plain chat');
assert(!state[779].job?.active, '(3) plain chat never opened a job');
console.log('  ✓ (3) plain-chat stall → plain notice, no resume');

// ── (4) budget exhaustion → the plain failure surfaces, restarts stop ─────
onPrimary = 'stall'; onResume = 'stall';
before = seen.prompts.length;
await conv.submit(780, BRIEF);
await waitFor(() => textsFor(780).some(t => t.includes('stopped answering')), '(4) plain failure after the budget is spent', 60000);
{
  const mine = seen.prompts.slice(before);
  assert(mine.length === 4, `(4) 1 original + 3 resumes (AUTO_RESUME_MAX), got ${mine.length}`);
  assert(mine.slice(1).every(pr => promptText(pr.body) === RESUME_TEXT), '(4) every restart used the resume text');
  assert(textsFor(780).filter(t => t === RESUME_NOTICE).length === 1, '(4) still exactly one resume notice for the whole job');
}
await sleep(2500);
assert(seen.prompts.length - before === 4, '(4) no fourth resume — the budget is spent');
console.log('  ✓ (4) budget exhausted at 3 restarts → plain stall failure surfaces, no loop');

// ── (5) transient 503 death inside a job → auto-resume (not just stalls) ──
onPrimary = 'fail503'; onResume = 'ok'; okText = 'Recovered and continuing.';
before = seen.prompts.length;
await conv.submit(781, BRIEF);
await waitFor(() => textsFor(781).includes('Recovered and continuing.'), '(5) resume after the 503 death delivered');
{
  const mine = seen.prompts.slice(before);
  assert(mine.length === 3, `(5) two failed attempts (in-turn guard retry) + one resume, got ${mine.length}`);
  assert(promptText(mine[2].body) === RESUME_TEXT, '(5) the third prompt is the bridge resume text');
  assert(textsFor(781).filter(t => t === RESUME_NOTICE).length === 1, '(5) exactly one auto-resume notice');
  assert(!textsFor(781).some(t => t.startsWith('❌')), '(5) no failure message reached the owner');
}
console.log('  ✓ (5) transient 503 death inside a job → auto-resume, no failure shown');

server.close();
console.log('autoresume: passed');
process.exit(0);
