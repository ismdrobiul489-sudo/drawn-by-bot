// instancelock group — the single-instance guard.
//
// Boots the real bot three times against the same data dir:
//   A: starts normally and takes data/bot.lock (pid recorded inside).
//   B: started while A lives → must exit NON-ZERO with the duplicate
//      message ("already running" + how to stop A) and must NEVER poll.
//   C: started after A was SIGKILLed (its lock left behind, pid dead)
//      → stale-lock takeover: reaches polling normally.
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

// Minimal mocks: the bot only needs Telegram polling + a healthy
// OpenCode status endpoint to reach "polling". No turns happen here.
function makeTelegram() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await readJsonBody(req);
    const reply = json => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
    const method = url.pathname.split('/').pop();
    if (method === 'getUpdates') { await sleep(300); return reply({ ok: true, result: [] }); }
    if (method === 'getMe') return reply({ ok: true, result: { id: 1, is_bot: true, first_name: 'Mock' } });
    return reply({ ok: true, result: { message_id: 1 } });
  });
  return { server };
}
function makeOpenCode() {
  const server = createServer(async (req, res) => {
    const reply = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json ?? {})); };
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/session/status') return reply(200, {});
    if (p === '/permission' || p === '/question') return reply(200, []);
    if (p === '/event') { res.writeHead(200, { 'content-type': 'text/event-stream' }); return; }
    return reply(404, { error: 'no route' });
  });
  return { server };
}
function makeProvider() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const reply = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json ?? {})); };
    if (url.pathname === '/groq/models') return reply(200, { data: [{ id: 'openai/gpt-oss-120b' }] });
    if (url.pathname === '/nvidia/models') return reply(200, { data: [{ id: 'nvidia/nemotron-3-super-120b-a12b' }] });
    if (req.method === 'POST') { await readJsonBody(req); return reply(200, { choices: [{ message: { content: 'ok' } }] }); }
    return reply(404, { error: 'no route' });
  });
  return { server };
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
  PUBLIC_BASE_URL: '', STORE_PORT: '0', MODEL_PROBE: 'on', ASK_POLL_SEC: '600',
};
function bootBot() {
  const child = spawn(process.execPath, [join(ROOT, 'bot', 'bot.mjs')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.log = '';
  child.stdout.on('data', d => { child.log += d; });
  child.stderr.on('data', d => { child.log += d; });
  child.exitCode = null;
  child.once('exit', code => { child.exitCode = code; });
  return child;
}
async function killBot(child) {
  child.kill('SIGKILL');
  await Promise.race([new Promise(r => child.once('exit', r)), sleep(3000)]);
}

let a = null; let c = null;
try {
  // A: normal start, takes the lock.
  a = bootBot();
  await waitFor(() => a.log.includes('polling'), 'instance A polling');
  assert(existsSync(REAL_LOCK), 'A wrote data/bot.lock');
  const lockA = JSON.parse(readFileSync(REAL_LOCK, 'utf8'));
  assert(lockA.pid === a.pid, `lock names A's pid (${lockA.pid} vs ${a.pid})`);
  console.log('  ✓ instance A holds the lock');

  // B: duplicate start while A lives → loud non-zero exit, no polling.
  const b = bootBot();
  await waitFor(() => b.exitCode !== null, 'instance B exits', 20000);
  assert(b.exitCode !== 0, `B exited non-zero (got ${b.exitCode})`);
  assert(b.log.includes('already running'), `B printed the duplicate message (log: ${b.log.slice(-400)})`);
  assert(b.log.includes(String(a.pid)), 'B\'s message names A\'s pid');
  assert(b.log.includes(`kill ${a.pid}`), 'B\'s message says how to stop A');
  assert(!b.log.includes('polling'), 'B never reached polling');
  console.log('  ✓ instance B refused with the duplicate message and never polled');

  // C: A dies uncleanly (SIGKILL — lock left behind, pid dead) →
  // stale-lock takeover.
  await killBot(a); a = null;
  assert(existsSync(REAL_LOCK), 'A\'s lock survived the SIGKILL (stale)');
  c = bootBot();
  await waitFor(() => c.log.includes('polling'), 'instance C polling after stale-lock takeover', 30000);
  const lockC = JSON.parse(readFileSync(REAL_LOCK, 'utf8'));
  assert(lockC.pid === c.pid, 'lock now names C\'s pid');
  console.log('  ✓ stale lock taken over silently; instance C runs');
} finally {
  if (a) await killBot(a);
  if (c) await killBot(c);
  for (const s of [tg.server, oc.server, prov.server]) s.close();
  restore();
}
console.log('instancelock: passed');
