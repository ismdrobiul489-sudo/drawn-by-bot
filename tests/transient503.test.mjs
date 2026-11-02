// Transient provider overload (503 / service_unavailable) — conversation
// level. Live incident 2026-11-02: after a cancelled turn, the owner's
// follow-up died with `OpenCode session error: {"message":"Service
// temporarily overloaded","type":"service_unavailable","code":503}` and
// the turn failed outright with a ❌. The model is fine — the service is
// momentarily overloaded — so the guard now classifies it as TRANSIENT
// (before the dead-model matcher): one owner notice, a short wait
// (TRANSIENT_RETRY_DELAY_SEC, 1s here), and ONE retry of the same text.
//
// One mock HTTP server plays BOTH the provider APIs (probes answer 200)
// and the OpenCode server, driven through the REAL AgentServer +
// Conversation classes with a fake Telegram (same harness as
// tpmfallback.test.mjs).
//
// Asserts:
//  (a) 503 on attempt 1 → notice sent once, retry carries the SAME text,
//      turn completes, NO model switch, NO ❌
//  (b) 503 on both attempts → exactly 2 prompts, exactly one notice, one
//      plain ❌ failure naming the cause — no loop
import { createServer } from 'node:http';

process.env.GROQ_API_KEY = 'gsk_503_test';
process.env.NVIDIA_API_KEY = 'nvapi_503_test';
process.env.DEFAULT_PROVIDER = 'nvidia';
process.env.GROQ_DEFAULT_MODEL = 'openai/gpt-oss-120b';
process.env.NVIDIA_DEFAULT_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
process.env.MODEL_PROBE = 'on';
process.env.OPENCODE_DRIVER = 'serve';
process.env.OPENCODE_TIMEOUT_MIN = '1';
process.env.TRANSIENT_RETRY_DELAY_SEC = '1';

// The exact live payload, as it lands in the session.error message.
const LIVE_503 = '{"message":"Service temporarily overloaded","type":"service_unavailable","code":503}';

const seen = { sessionCreates: [], prompts: [] };
let eventRes = null;
let failMode = 'first'; // 'first' → only attempt 1 errors; 'always' → every attempt errors

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const readBody = cb => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => cb(Buffer.concat(c).toString())); };

  if (p.endsWith('/chat/completions')) {
    return readBody(b => { json(200, { choices: [{ message: { content: 'ok' } }] }); });
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
    return readBody(b => { seen.sessionCreates.push(JSON.parse(b || '{}')); json(200, { id: 'ses_503', slug: 'x', title: 'test', time: { created: 1, updated: 1 } }); });
  }
  if (p === '/session/ses_503' && req.method === 'GET') return json(200, { id: 'ses_503' });
  if (p === '/session/ses_503/prompt_async') {
    return readBody(b => {
      const body = JSON.parse(b || '{}');
      seen.prompts.push(body);
      const attempt = seen.prompts.length;
      json(204, {});
      setTimeout(() => {
        const shouldFail = failMode === 'always' || attempt === 1;
        if (shouldFail) {
          eventRes?.write('data: ' + JSON.stringify({ type: 'session.error', properties: { sessionID: 'ses_503', error: { name: 'UnknownError', data: { message: LIVE_503 } } } }) + '\n\n');
        } else {
          eventRes?.write('data: ' + JSON.stringify({ type: 'message.part.delta', properties: { sessionID: 'ses_503', messageID: 'msg_ok', partID: 'p1', field: 'text', delta: 'Recovered after the overload.' } }) + '\n\n');
          eventRes?.write('data: ' + JSON.stringify({ type: 'session.idle', properties: { sessionID: 'ses_503' } }) + '\n\n');
        }
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
const { Conversation } = await import('../bot/conversation.mjs');

const tgLog = { sent: [] };
const tg = {
  sendMessage: async (chatId, text) => { tgLog.sent.push(text); return { message_id: tgLog.sent.length }; },
  editMessageText: async () => true,
  sendChatAction: async () => true,
};
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
async function waitFor(fn, what, ms = 20000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await sleep(60); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const promptText = b => (b.parts || []).map(x => x.text || '').join('\n');

// ── (a) 503 once → notice + same-text retry → turn completes ──────────────
failMode = 'first';
await conv.submit(777, 'Make a video about the sea');
await waitFor(() => tgLog.sent.some(t => t.includes('Recovered after the overload.')), 'reply after the retry');
assert(seen.prompts.length === 2, `(a) exactly 2 prompts (failed + retry), got ${seen.prompts.length}`);
assert(promptText(seen.prompts[1]) === promptText(seen.prompts[0]), '(a) the retry carries the SAME turn text (no switch note, no rewrite)');
const notices = tgLog.sent.filter(t => t.includes('temporarily overloaded — retrying once'));
assert(notices.length === 1, `(a) exactly one overload notice, got ${notices.length}: ${JSON.stringify(tgLog.sent)}`);
assert(!tgLog.sent.some(t => t.startsWith('❌')), `(a) no failure message on the recovered turn: ${JSON.stringify(tgLog.sent)}`);
assert(state[777].selection.provider === 'nvidia' && state[777].selection.model === 'nvidia/nemotron-3-ultra-550b-a55b',
  '(a) standing selection unchanged — a transient overload is NOT a model switch');

// ── (b) 503 twice → one notice, one plain failure, no loop ────────────────
seen.prompts.length = 0; tgLog.sent.length = 0;
failMode = 'always';
await conv.submit(778, 'Make a video about the hills');
await waitFor(() => tgLog.sent.some(t => t.includes('could not finish')), 'plain failure after the second 503');
const failMsg = tgLog.sent.find(t => t.includes('could not finish'));
assert(failMsg.includes('temporarily overloaded'), `(b) failure names the cause: ${failMsg.slice(0, 220)}`);
assert(seen.prompts.length === 2, `(b) exactly 2 prompts (attempt + one retry), got ${seen.prompts.length}`);
assert(tgLog.sent.filter(t => t.includes('temporarily overloaded — retrying once')).length === 1, '(b) exactly one overload notice');
await sleep(700);
assert(seen.prompts.length === 2, '(b) no third prompt — no retry loop');

server.close();
console.log('  ✓ 503 once → notice + same-text retry completes, selection untouched');
console.log('  ✓ 503 twice → single plain failure naming the overload, no loop');
console.log('transient503: passed');
process.exit(0);
