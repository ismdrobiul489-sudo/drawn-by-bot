// stallwatch group — the turn watchdog, end to end against mocks.
//
// The mock OpenCode keeps the session BUSY forever on the first prompt
// (no events, no idle — a model that stopped answering). With tiny env
// timeouts (TURN_STALL_MIN=0.05 = 3 s) the bot must:
//   • acknowledge the turn ("🤔 On it…"),
//   • post ONE stall message naming the standing model within the bound,
//   • free the queue: a following message starts a NEW turn that works.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const OWNER = 4242;
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, what, ms = 30000) {
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

// ── Mock OpenCode: first prompt hangs the session busy forever ──────
function makeOpenCode() {
  const state = { prompts: [], hanging: false, subscribers: new Set(), sid: 'ses_stall_1' };
  const emit = ev => { for (const res of [...state.subscribers]) { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch {} } };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const reply = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json ?? {})); };
    if (req.method === 'GET' && p === '/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.flushHeaders(); // real servers flush at once (server.connected); unflushed headers would fake a dead stream
      state.subscribers.add(res);
      req.on('close', () => state.subscribers.delete(res));
      return;
    }
    if (req.method === 'GET' && p === '/session/status') return reply(200, state.hanging ? { [state.sid]: { type: 'busy' } } : {});
    if (req.method === 'POST' && p === '/session') { await readJsonBody(req); return reply(200, { id: state.sid, directory: url.searchParams.get('directory') || '' }); }
    if (req.method === 'GET' && p === `/session/${state.sid}`) return reply(200, { id: state.sid });
    if (req.method === 'GET' && p === `/session/${state.sid}/message`) return reply(200, []);
    if (req.method === 'GET' && (p === '/permission' || p === '/question')) return reply(200, []);
    if (req.method === 'POST' && p.includes('/prompt_async')) {
      const body = await readJsonBody(req);
      state.prompts.push(body);
      if (state.prompts.length === 1) { state.hanging = true; return reply(204, {}); } // never idles
      setTimeout(() => {
        state.hanging = false;
        const mid = `msg_back_${Date.now()}`;
        emit({ type: 'message.part.delta', properties: { sessionID: state.sid, messageID: mid, partID: 'p1', field: 'text', delta: 'back again' } });
        emit({ type: 'session.idle', properties: { sessionID: state.sid } });
      }, 40);
      return reply(204, {});
    }
    if (req.method === 'POST' && p.includes('/abort')) { state.hanging = false; return reply(200, true); }
    return reply(404, { error: 'no route ' + req.method + ' ' + p });
  });
  return { server, state };
}

// ── Mock provider (probes + lists) ──────────────────────────────────
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

// ── Mock Telegram (same shape as flow.test.mjs) ─────────────────────
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
  TURN_STALL_MIN: '0.05', // 3 s
  TURN_MAX_MIN: '2',
  ASK_POLL_SEC: '600',
};
const child = spawn(process.execPath, [join(ROOT, 'bot', 'bot.mjs')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
child.log = '';
child.stdout.on('data', d => { child.log += d; });
child.stderr.on('data', d => { child.log += d; });

try {
  await waitFor(() => child.log.includes('polling'), 'bot polling');
  const t0 = Date.now();
  tg.say('make a video about deserts');
  await waitFor(() => tg.texts().some(t => t.includes('🤔 On it')), 'turn-start acknowledgement posted');
  const stall = await waitFor(() => tg.texts().find(t => t.includes('stopped answering')), 'stall message naming the model', 30000);
  const elapsed = Date.now() - t0;
  assert(stall.includes('openai/gpt-oss-120b'), `stall message names the standing model (got: ${stall.slice(0, 140)})`);
  assert(stall.includes('groq'), 'stall message names the provider');
  assert(elapsed < 25000, `stall message arrived within the bound (${elapsed} ms)`);
  assert(oc.state.prompts.length === 1, 'only the hung prompt so far');

  // The queue is free: the next message starts a fresh turn that works.
  tg.say('are you back?');
  await waitFor(() => oc.state.prompts.length === 2, 'second turn prompted after the watchdog trip');
  await waitFor(() => tg.texts().some(t => t.includes('back again')), 'second turn reply delivered');
  await sleep(600);
  assert(tg.texts().filter(t => t.includes('stopped answering')).length === 1, 'exactly one stall message');
  console.log(`  ✓ watchdog: ack posted, stall message in ${elapsed} ms naming groq/openai/gpt-oss-120b, next message turned normally`);
} finally {
  if (process.env.DBB_DEBUG) console.log('\n--- bot child log ---\n' + child.log.slice(-4000) + '\n--- end bot log ---');
  child.kill('SIGKILL');
  await Promise.race([new Promise(r => child.once('exit', r)), sleep(3000)]);
  for (const s of [tg.server, oc.server, prov.server]) s.close();
  restore();
}
console.log('stallwatch: passed');
