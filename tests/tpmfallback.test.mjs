// TPM / token-limit fallback — conversation level (amendment-era rewrite
// of the old processor-level test; same live incident, same assertions).
//
// One mock HTTP server plays BOTH the provider APIs (every probe answers
// 200 — the models are ALIVE) and the OpenCode server (session /
// prompt_async / SSE /event), driven through the REAL AgentServer +
// Conversation classes with a fake Telegram. A prompt pinned to Groq
// fails the turn with the EXACT error the owner hit live — "Request too
// large for model `openai/gpt-oss-120b` … tokens per minute (TPM): Limit
// 8000, Requested 10703" — because Groq free's 8K TPM can never fit a
// ~10.7K-token first turn, while the 1-token probe passes fine.
//
// Asserts:
//  (a) session-create and prompt bodies carry the STANDING provider/model
//  (b) TPM on the first turn → standing selection switches to the OTHER
//      provider's .env default, the switch is announced PERSISTENTLY
//      (standalone message — never the rolling status edit), the new
//      selection is SAVED for future turns, and the turn is RETRIED on
//      the new model with the note + the owner's original text
//  (c) TPM on BOTH providers → loud named failure to the owner and NO
//      third prompt (exactly one retry)
import { createServer } from 'node:http';

process.env.GROQ_API_KEY = 'gsk_tpm_test';
process.env.NVIDIA_API_KEY = 'nvapi_tpm_test';
process.env.DEFAULT_PROVIDER = 'groq';
process.env.GROQ_DEFAULT_MODEL = 'openai/gpt-oss-120b';
process.env.NVIDIA_DEFAULT_MODEL = 'nvidia/nemotron-3-super-120b-a12b';
process.env.MODEL_PROBE = 'on';
process.env.OPENCODE_DRIVER = 'serve';
process.env.OPENCODE_TIMEOUT_MIN = '1';

const TPM_MSG = 'Request too large for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 10703, please reduce your message size and try again later.';

const seen = { sessionCreates: [], prompts: [], probes: [] };
let eventRes = null;
let failNvidiaToo = false; // flipped on for the both-providers-TPM scenario

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const readBody = cb => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => cb(Buffer.concat(c).toString())); };

  // Provider probes: every model answers — the models are ALIVE.
  if (p.endsWith('/chat/completions')) {
    return readBody(b => { seen.probes.push(JSON.parse(b || '{}').model); json(200, { choices: [{ message: { content: 'ok' } }] }); });
  }
  if (p === '/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    eventRes = res;
    return;
  }
  if (p === '/global/health') return json(200, { healthy: true, version: 'mock' });
  if (p === '/session/status') return json(200, {}); // {} = idle (AgentServer.healthy)
  if (p === '/session' && req.method === 'POST') {
    return readBody(b => { seen.sessionCreates.push(JSON.parse(b || '{}')); json(200, { id: 'ses_tpm', slug: 'tpm', title: 'test', time: { created: 1, updated: 1 } }); });
  }
  if (p === '/session/ses_tpm' && req.method === 'GET') return json(200, { id: 'ses_tpm' });
  if (p === '/session/ses_tpm/prompt_async') {
    return readBody(b => {
      const body = JSON.parse(b || '{}');
      seen.prompts.push(body);
      json(204, {});
      // Then "run" the turn: fail on groq with the TPM error, succeed on
      // nvidia with a streamed reply.
      setTimeout(() => {
        const model = body.model?.modelID;
        if (model === 'openai/gpt-oss-120b' || (failNvidiaToo && model === 'nvidia/nemotron-3-super-120b-a12b')) {
          eventRes?.write('data: ' + JSON.stringify({ type: 'session.error', properties: { sessionID: 'ses_tpm', error: { name: 'APIError', data: { message: TPM_MSG, statusCode: 429 } } } }) + '\n\n');
        } else {
          eventRes?.write('data: ' + JSON.stringify({ type: 'message.part.delta', properties: { sessionID: 'ses_tpm', messageID: 'msg_ok', partID: 'p1', field: 'text', delta: 'Done on the switched model.' } }) + '\n\n');
        }
        eventRes?.write('data: ' + JSON.stringify({ type: 'session.idle', properties: { sessionID: 'ses_tpm' } }) + '\n\n');
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

const tgLog = { sent: [], edits: [] };
const tg = {
  sendMessage: async (chatId, text) => { tgLog.sent.push(text); return { message_id: tgLog.sent.length }; },
  editMessageText: async (chatId, id, text) => { tgLog.edits.push(text); return true; },
  sendChatAction: async () => true,
};
const state = {};
const chatState = id => (state[id] ||= { step: 'idle' });
const conv = new Conversation({
  tg, agent: new AgentServer(),
  chatState, saveState: () => {},
  selectionOf: cs => (cs.selection ??= { provider: 'groq', model: 'openai/gpt-oss-120b' }),
  setSelection: (cs, sel) => { cs.selection = { ...sel }; },
  sessionDirectory: '/tmp',
  settleMs: 50,
  outbox: { arrivedCount: 0 },
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, what, ms = 15000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await sleep(60); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

// ── Happy path: TPM on groq → switch → retry succeeds ──────────────────────
await conv.submit(777, 'Tell me about the monsoon');
await waitFor(() => tgLog.sent.some(t => t.includes('Done on the switched model.')), 'reply on the switched model');

// (a) session + prompt pin the standing selection
assert(seen.sessionCreates.length === 1, `(a) one session created (got ${seen.sessionCreates.length})`);
assert(seen.prompts.length === 2, `(b) exactly 2 prompts (failed + retry), got ${seen.prompts.length}`);
assert(seen.prompts[0].model.providerID === 'groq' && seen.prompts[0].model.modelID === 'openai/gpt-oss-120b',
  `(a) first prompt pinned to groq/openai/gpt-oss-120b: ${JSON.stringify(seen.prompts[0].model)}`);
assert(seen.prompts[0].agent === 'video-maker', '(a) video-maker agent on the prompt');

// (b) switch + persistent notice + retry with note and original text
assert(seen.prompts[1].model.providerID === 'nvidia' && seen.prompts[1].model.modelID === 'nvidia/nemotron-3-super-120b-a12b',
  `(b) retry prompt pinned to nvidia default: ${JSON.stringify(seen.prompts[1].model)}`);
const retryText = seen.prompts[1].parts.map(x => x.text || '').join('\n');
assert(retryText.includes('[Note: the previous model failed') && retryText.includes('TPM'),
  `(b) retry carries the failure note: ${retryText.slice(0, 200)}`);
assert(retryText.includes('Tell me about the monsoon'), '(b) retry carries the original user text');
const announce = tgLog.sent.find(t => t.includes('⚠️') && t.includes('nvidia / nvidia/nemotron-3-super-120b-a12b'));
assert(announce, `(b) persistent switch notice sent as its own message: ${JSON.stringify(tgLog.sent)}`);
assert(state[777].selection.provider === 'nvidia' && state[777].selection.model === 'nvidia/nemotron-3-super-120b-a12b',
  '(b) standing selection saved as nvidia for future turns');
assert(seen.probes.includes('openai/gpt-oss-120b') && seen.probes.includes('nvidia/nemotron-3-super-120b-a12b'),
  `(b) both models were probed along the way: ${JSON.stringify(seen.probes)}`);

// ── (c) Both providers TPM → loud named failure, exactly one retry ────────
seen.prompts.length = 0; tgLog.sent.length = 0;
failNvidiaToo = true;
await conv.submit(778, 'another monsoon question');
await waitFor(() => tgLog.sent.some(t => t.includes('could not finish')), 'loud failure surfaced to the owner');
const failMsg = tgLog.sent.find(t => t.includes('could not finish'));
assert(/tpm|tokens per minute|too large/i.test(failMsg), `(c) failure message names the cause: ${failMsg.slice(0, 200)}`);
assert(seen.prompts.length === 2, `(c) exactly 2 prompts (attempt + one retry), got ${seen.prompts.length}`);

server.close();
console.log('  ✓ TPM turn → provider switch + persistent notice + note-carrying retry, selection saved');
console.log('tpmfallback: passed');
process.exit(0);
