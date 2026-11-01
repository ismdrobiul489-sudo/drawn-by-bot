// sserecovery group — turns survive a dead event stream.
//
// The mock OpenCode BLACKHOLES /event (accepts the connection, never
// sends a single byte — the half-open failure from the live incident)
// while the rest of the API works. Against it:
//   (a) a turn completes server-side with its text only in the stored
//       messages — the owner must still receive it (settle-time fetch
//       from GET /session/{id}/message, deduped against the stream);
//   (b) the agent asks a question mid-turn — with no SSE it can only
//       reach the owner via the relay's poll backstop; the owner taps
//       an answer and the turn completes with its reply delivered.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const OWNER = 4242;
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, what, ms = 45000) {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`); await sleep(80); }
}
function readJsonBody(req) {
  return new Promise(resolveBody => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { try { resolveBody(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { resolveBody({}); } });
  });
}

// ── Mock OpenCode: dead /event, living REST ─────────────────────────
function makeOpenCode() {
  const state = {
    sid: 'ses_rec_1', prompts: [], busy: false, messages: [], pendingQuestion: null, answers: null,
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const reply = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json ?? {})); };
    if (req.method === 'GET' && p === '/event') {
      // BLACKHOLE: accept and never write anything, not even headers.
      req.on('close', () => {});
      return;
    }
    if (req.method === 'GET' && p === '/session/status') return reply(200, state.busy ? { [state.sid]: { type: 'busy' } } : {});
    if (req.method === 'POST' && p === '/session') { await readJsonBody(req); return reply(200, { id: state.sid, directory: url.searchParams.get('directory') || '' }); }
    if (req.method === 'GET' && p === `/session/${state.sid}`) return reply(200, { id: state.sid });
    if (req.method === 'GET' && p === `/session/${state.sid}/message`) return reply(200, state.messages);
    if (req.method === 'GET' && p === '/permission') return reply(200, []);
    if (req.method === 'GET' && p === '/question') return reply(200, state.pendingQuestion ? [state.pendingQuestion] : []);
    if (req.method === 'POST' && p.includes('/prompt_async')) {
      const body = await readJsonBody(req);
      state.prompts.push(body);
      if (state.prompts.length === 1) {
        // Turn A: completes instantly server-side; text lives ONLY in
        // the stored messages (the stream is dead, nothing is emitted).
        state.messages.push({
          info: { id: 'msg_rec_a', role: 'assistant', time: { created: Date.now() } },
          parts: [{ type: 'text', text: 'Recovered reply, no stream needed', messageID: 'msg_rec_a' }],
        });
        state.busy = false;
      } else {
        // Turn B: the agent asks a question and waits (session busy).
        state.busy = true;
        state.pendingQuestion = {
          id: 'que_rec_1', sessionID: state.sid,
          questions: [{ question: 'Which style?', header: 'Style', options: [{ label: 'Line', description: 'thin lines' }, { label: 'Bold', description: 'bold shapes' }] }],
          tool: { messageID: 'm', callID: 'c' },
        };
      }
      return reply(204, {});
    }
    if (req.method === 'POST' && /^\/question\/[^/]+\/reply$/.test(p)) {
      const body = await readJsonBody(req);
      state.answers = body.answers;
      state.pendingQuestion = null;
      state.busy = false;
      state.messages.push({
        info: { id: 'msg_rec_b', role: 'assistant', time: { created: Date.now() } },
        parts: [{ type: 'text', text: 'Done — Line it is.', messageID: 'msg_rec_b' }],
      });
      return reply(200, true);
    }
    if (req.method === 'POST' && p.includes('/abort')) { state.busy = false; return reply(200, true); }
    return reply(404, { error: 'no route ' + req.method + ' ' + p });
  });
  return { server, state };
}

function makeProvider() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const reply = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json ?? {})); };
    if (req.method === 'GET' && url.pathname === '/groq/models') return reply(200, { data: [{ id: 'openai/gpt-oss-120b' }] });
    if (req.method === 'GET' && url.pathname === '/nvidia/models') return reply(200, { data: [{ id: 'nvidia/nemotron-3-super-120b-a12b' }] });
    if (req.method === 'POST' && /^\/(groq|nvidia)\/chat\/completions$/.test(url.pathname)) { await readJsonBody(req); return reply(200, { choices: [{ message: { content: 'ok' } }] }); }
    return reply(404, { error: 'no route' });
  });
  return { server };
}

function makeTelegram() {
  const calls = [];
  const updates = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await readJsonBody(req);
    const reply = json => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
    const method = url.pathname.split('/').pop();
    if (method === 'getUpdates') {
      let mine = updates.filter(u => u.update_id >= (body.offset || 0)).slice(0, 10);
      if (!mine.length) { await sleep(400); mine = updates.filter(u => u.update_id >= (body.offset || 0)).slice(0, 10); }
      return reply({ ok: true, result: mine });
    }
    if (method === 'getMe') return reply({ ok: true, result: { id: 1, is_bot: true, first_name: 'Mock' } });
    calls.push({ method, ...body });
    return reply({ ok: true, result: { message_id: calls.length } });
  });
  let uid = 1000;
  const push = u => updates.push({ update_id: ++uid, ...u });
  return {
    server, calls,
    say: text => push({ message: { message_id: uid, chat: { id: OWNER }, from: { id: OWNER }, text } }),
    tap: data => push({ callback_query: { id: `cb${uid}`, from: { id: OWNER }, message: { message_id: 1, chat: { id: OWNER } }, data } }),
    sent: () => calls.filter(c => c.method === 'sendMessage'),
    texts: () => calls.filter(c => c.method === 'sendMessage').map(c => c.text || ''),
  };
}

const REAL_STATE = join(ROOT, 'data', 'state.json');
const REAL_PENDING = join(ROOT, 'data', 'pending.json');
const REAL_LOCK = join(ROOT, 'data', 'bot.lock');
const stash = {};
for (const [k, p] of Object.entries({ state: REAL_STATE, pending: REAL_PENDING, lock: REAL_LOCK })) {
  stash[k] = existsSync(p) ? readFileSync(p, 'utf8') : null;
  rmSync(p, { force: true });
}
function restore() {
  for (const [k, p] of Object.entries({ state: REAL_STATE, pending: REAL_PENDING, lock: REAL_LOCK })) {
    if (stash[k] === null) rmSync(p, { force: true }); else writeFileSync(p, stash[k]);
  }
}

const tg = makeTelegram();
const oc = makeOpenCode();
const prov = makeProvider();
for (const s of [tg.server, oc.server, prov.server]) await new Promise(r => s.listen(0, '127.0.0.1', r));
const env = {
  ...process.env,
  TELEGRAM_BOT_TOKEN: 'TEST',
  TELEGRAM_API_BASE: `http://127.0.0.1:${tg.server.address().port}`,
  OWNER_TELEGRAM_ID: String(OWNER),
  OPENCODE_SERVER_URL: `http://127.0.0.1:${oc.server.address().port}`,
  OPENCODE_BIN: 'true',
  GROQ_API_KEY: 'gsk_test', NVIDIA_API_KEY: 'nvapi_test',
  GROQ_BASE_URL: `http://127.0.0.1:${prov.server.address().port}/groq`,
  NVIDIA_BASE_URL: `http://127.0.0.1:${prov.server.address().port}/nvidia`,
  DEFAULT_PROVIDER: 'groq', GROQ_DEFAULT_MODEL: 'openai/gpt-oss-120b',
  NVIDIA_DEFAULT_MODEL: 'nvidia/nemotron-3-super-120b-a12b',
  PUBLIC_BASE_URL: '', STORE_PORT: '0', MODEL_PROBE: 'on',
  ASK_POLL_SEC: '1', // relay backstop sweeps every second in this test
};
const child = spawn(process.execPath, [join(ROOT, 'bot', 'bot.mjs')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
child.log = '';
child.stdout.on('data', d => { child.log += d; });
child.stderr.on('data', d => { child.log += d; });

try {
  await waitFor(() => child.log.includes('polling'), 'bot polling');

  // (a) Dead stream: the reply exists only in the session store.
  tg.say('make a rain video');
  await waitFor(() => tg.texts().some(t => t.includes('Recovered reply, no stream needed')), 'reply recovered via the settle-time message fetch', 60000);
  console.log('  ✓ (a) assistant text recovered from GET /session/{id}/message despite the blackholed /event');

  // (b) A question asked while SSE is dead surfaces via the relay poll.
  tg.say('make another one');
  const askMsg = await waitFor(() => tg.sent().find(m => (m.text || '').includes('Which style?')), 'question surfaced by the relay poll backstop', 60000);
  assert(JSON.stringify(askMsg.reply_markup).includes('q:que_rec_1:0'), 'answer buttons present');
  tg.tap('q:que_rec_1:0');
  await waitFor(() => oc.state.answers, 'answer returned to OpenCode');
  assert(JSON.stringify(oc.state.answers) === JSON.stringify([['Line']]), 'answer payload correct');
  await waitFor(() => tg.texts().some(t => t.includes('Done — Line it is.')), 'post-answer reply delivered', 60000);
  console.log('  ✓ (b) question surfaced via the relay poll (no SSE), answer returned, turn completed');
} finally {
  child.kill('SIGKILL');
  await Promise.race([new Promise(r => child.once('exit', r)), sleep(3000)]);
  for (const s of [tg.server, oc.server, prov.server]) s.close();
  restore();
}
console.log('sserecovery: passed');
