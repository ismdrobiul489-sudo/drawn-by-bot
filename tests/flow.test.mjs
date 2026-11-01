// flow group — the CONVERSATIONAL bot, end to end against mocks.
//
// Spawns the real bot (bot/bot.mjs) as a child process with:
//   • a mock Telegram Bot API (records every call the bot makes),
//   • a mock OpenCode serve (scriptable sessions/prompts; can raise
//     question.asked events and scripted assistant replies),
//   • mock provider /models + /chat/completions (probes + model lists).
//
// Covers: (a) plain text → turn with the standing model, reply delivered,
// NO /start anywhere; (b) a message during a busy turn is queued and
// delivered after; (c) /new archives + fresh session, /model switches the
// standing selection and the next turn uses it; (d) question.asked →
// buttons → answer returns; (e) a send_file request in data/outbox/ is
// sent by the bot watcher; (f) first-turn TPM → switch + persistent
// notice + retried turn succeeds; (g) the owner lock rejects strangers;
// plus /start status, voice intake (transcribed + forwarded), the
// claims-but-didn't-deliver nudge (amendment A3), and old-state migration.
//
// NOTE: the bot resolves data/ from the REPO root (lib/env ROOT), so the
// tests snapshot the real data/state.json before boot and restore it
// after — the repo's own state is never clobbered by a test run.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const OWNER = 4242;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
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

// ── Mock provider (groq + nvidia on one server, split by path) ─────────────
function makeProvider({ groqList, nvidiaList, probeBehavior }) {
  const probes = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const reply = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json ?? {})); };
    if (req.method === 'GET' && url.pathname === '/groq/models') return reply(200, { data: groqList.map(id => ({ id })) });
    if (req.method === 'GET' && url.pathname === '/nvidia/models') return reply(200, { data: nvidiaList.map(id => ({ id })) });
    if (req.method === 'POST' && /^\/(groq|nvidia)\/chat\/completions$/.test(url.pathname)) {
      const body = await readJsonBody(req);
      probes.push({ provider: url.pathname.split('/')[1], model: body.model });
      const b = probeBehavior(body.model);
      if (b && b.status) return reply(b.status, { error: { message: b.message || 'probe failed' } });
      return reply(200, { choices: [{ message: { content: 'ok' } }] });
    }
    if (req.method === 'POST' && url.pathname === '/groq/audio/transcriptions') {
      await readJsonBody(req).catch(() => {});
      return reply(200, {
        text: 'This is my recorded narration.', language: 'en', duration: 3,
        segments: [{ start: 0, end: 3, text: 'This is my recorded narration.' }],
        words: [
          { word: 'This', start: 0, end: 0.4 }, { word: 'is', start: 0.5, end: 0.7 },
          { word: 'my', start: 0.8, end: 1 }, { word: 'recorded', start: 1.1, end: 1.8 },
          { word: 'narration.', start: 1.9, end: 2.8 },
        ],
      });
    }
    return reply(404, { error: 'no route ' + req.method + ' ' + url.pathname });
  });
  return { server, probes };
}

// ── Mock OpenCode serve ─────────────────────────────────────────────────────
function makeOpenCode({ onPrompt, replyFor }) {
  const state = { sessions: [], prompts: [], subscribers: new Set(), questions: new Map() };
  const emit = ev => { for (const res of [...state.subscribers]) { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch {} } };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (req.method === 'GET' && p === '/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      state.subscribers.add(res);
      req.on('close', () => state.subscribers.delete(res));
      return;
    }
    const reply = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json ?? {})); };
    if (req.method === 'GET' && p === '/global/health') return reply(200, { healthy: true, version: 'mock' });
    if (req.method === 'GET' && p === '/session/status') return reply(200, {}); // {} = every session idle (AgentServer.healthy + busy checks)
    if (req.method === 'POST' && p === '/session') {
      await readJsonBody(req);
      const sid = `ses_mock_${state.sessions.length + 1}`;
      const s = { id: sid, directory: url.searchParams.get('directory') || '' };
      state.sessions.push(s);
      return reply(200, { id: sid, title: 'mock', directory: s.directory });
    }
    if (req.method === 'GET' && /^\/session\/[^/]+$/.test(p)) {
      const s = state.sessions.find(x => x.id === p.split('/')[2]);
      return s ? reply(200, s) : reply(404, { error: 'no session' });
    }
    if (req.method === 'POST' && p.includes('/prompt_async')) {
      const body = await readJsonBody(req);
      const sid = p.split('/')[2];
      state.prompts.push({ sid, body });
      const action = onPrompt ? onPrompt({ sid, body, n: state.prompts.length }) : null;
      if (action?.error) return reply(action.error.status || 500, { error: { message: action.error.message } });
      const finish = () => {
        const text = action?.text ?? replyFor(body);
        const mid = `msg_${state.prompts.length}_${Date.now()}`;
        emit({ type: 'message.part.delta', properties: { sessionID: sid, messageID: mid, partID: 'p1', field: 'text', delta: text } });
        emit({ type: 'session.idle', properties: { sessionID: sid } });
      };
      setTimeout(finish, action?.delayMs ?? 30);
      return reply(204, {});
    }
    if (req.method === 'POST' && p.includes('/abort')) return reply(200, true);
    if (req.method === 'POST' && /^\/question\/[^/]+\/reply$/.test(p)) {
      const body = await readJsonBody(req);
      state.questions.set(p.split('/')[2], body.answers);
      return reply(200, true);
    }
    if (req.method === 'POST' && /^\/permission\/[^/]+\/reply$/.test(p)) return reply(200, true);
    return reply(404, { error: 'no route ' + req.method + ' ' + p });
  });
  state.askQuestion = (sid, request) => {
    emit({ type: 'question.asked', properties: { id: request.id, sessionID: sid, questions: request.questions, tool: { messageID: 'm', callID: 'c' } } });
  };
  return { server, state };
}

// ── Mock Telegram ───────────────────────────────────────────────────────────
function makeTelegram() {
  const calls = [];
  const updates = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    // File downloads live on the same base as the API (real Telegram
    // layout): GET /file/bot<token>/<file_path> → the file bytes.
    if (req.method === 'GET' && url.pathname.startsWith('/file/')) {
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(tinyWav());
      return;
    }
    // Multipart calls (sendVideo/sendPhoto/sendDocument) carry their
    // fields as form parts — extract the text fields so tests can
    // assert captions; JSON calls parse as before.
    let body = {};
    if ((req.headers['content-type'] || '').includes('multipart/form-data')) {
      const raw = await new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString('utf8'))); });
      for (const m of raw.matchAll(/name="(\w+)"\r\n\r\n([^\r]*)/g)) { try { body[m[1]] = JSON.parse(m[2]); } catch { body[m[1]] = m[2]; } }
    } else {
      body = await readJsonBody(req);
    }
    const reply = (json) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
    const method = url.pathname.split('/').pop(); // strip the /bot<token> prefix
    if (method === 'getUpdates') {
      // Telegram offset semantics: offset = last seen id + 1; updates
      // with id >= offset are (re)delivered.
      let mine = updates.filter(u => u.update_id >= (body.offset || 0)).slice(0, 10);
      if (!mine.length) {
        // Simulate Telegram long-polling: hold the request briefly so
        // the bot's poll loop doesn't spin hot against an instant mock.
        await sleep(400);
        mine = updates.filter(u => u.update_id >= (body.offset || 0)).slice(0, 10);
      }
      return reply({ ok: true, result: mine });
    }
    if (method === 'getMe') return reply({ ok: true, result: { id: 1, is_bot: true, first_name: 'Mock' } });
    if (method === 'getFile') return reply({ ok: true, result: { file_id: body.file_id, file_path: 'voice/file_1.oga' } });
    calls.push({ method, ...body });
    return reply({ ok: true, result: { message_id: calls.length } });
  });
  let uid = 1000;
  const push = u => updates.push({ update_id: ++uid, ...u });
  return {
    server, calls, updates,
    say: text => push({ message: { message_id: uid, chat: { id: OWNER }, from: { id: OWNER }, text } }),
    sayAs: (id, text) => push({ message: { message_id: uid, chat: { id }, from: { id }, text } }),
    voice: () => push({ message: { message_id: uid, chat: { id: OWNER }, from: { id: OWNER }, voice: { file_id: 'voice-file-1', duration: 3, mime_type: 'audio/ogg' } } }),
    tap: data => push({ callback_query: { id: `cb${uid}`, from: { id: OWNER }, message: { message_id: 1, chat: { id: OWNER } }, data } }),
    sent: () => calls.filter(c => c.method === 'sendMessage'),
    texts: () => calls.filter(c => c.method === 'sendMessage').map(c => c.text || ''),
  };
}

// A tiny valid WAV (0.1s silence) so ffprobe/ffmpeg accept the "voice" file.
function tinyWav() {
  const sr = 8000, n = 800, dataLen = n * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataLen, 40);
  return buf;
}

// ── Bot child harness ───────────────────────────────────────────────────────
const REAL_STATE = join(ROOT, 'data', 'state.json');
const REAL_PENDING = join(ROOT, 'data', 'pending.json');
const REAL_LOCK = join(ROOT, 'data', 'bot.lock');
const REAL_MEMORY = join(ROOT, 'data', 'memory');
let savedRealState = null;
let savedRealPending = null;
let savedRealLock = null;
let savedMemory = null; // { 'preferences.md': string|null, 'index.md': string|null }
function snapshotRealState() {
  savedRealState = existsSync(REAL_STATE) ? readFileSync(REAL_STATE, 'utf8') : null;
  savedRealPending = existsSync(REAL_PENDING) ? readFileSync(REAL_PENDING, 'utf8') : null;
  savedRealLock = existsSync(REAL_LOCK) ? readFileSync(REAL_LOCK, 'utf8') : null;
  rmSync(REAL_LOCK, { force: true }); // a killed child's lock is stale (dead pid) and would be taken over anyway; removing is deterministic
  savedMemory = {};
  for (const f of ['preferences.md', 'index.md']) {
    const p = join(REAL_MEMORY, f);
    savedMemory[f] = existsSync(p) ? readFileSync(p, 'utf8') : null;
    rmSync(p, { force: true });
  }
  rmSync(REAL_STATE, { force: true });
  rmSync(REAL_PENDING, { force: true }); // a leftover pending ask would be re-sent at boot and pollute assertions
}
function restoreRealState() {
  if (savedRealState === null) rmSync(REAL_STATE, { force: true });
  else writeFileSync(REAL_STATE, savedRealState);
  if (savedRealPending === null) rmSync(REAL_PENDING, { force: true });
  else writeFileSync(REAL_PENDING, savedRealPending);
  if (savedRealLock === null) rmSync(REAL_LOCK, { force: true });
  else writeFileSync(REAL_LOCK, savedRealLock);
  if (savedMemory) for (const [f, content] of Object.entries(savedMemory)) {
    const p = join(REAL_MEMORY, f);
    if (content === null) rmSync(p, { force: true });
    else { mkdirSync(REAL_MEMORY, { recursive: true }); writeFileSync(p, content); }
  }
}
/** Seed data/memory/ (call AFTER snapshotRealState, before bootBot). */
function seedMemory(prefs, indexLines) {
  mkdirSync(REAL_MEMORY, { recursive: true });
  if (prefs != null) writeFileSync(join(REAL_MEMORY, 'preferences.md'), prefs);
  if (indexLines != null) writeFileSync(join(REAL_MEMORY, 'index.md'), indexLines);
}
const readState = () => JSON.parse(readFileSync(REAL_STATE, 'utf8'));

async function bootBot({ ocBehavior, probes = {} } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'dbb-flow-'));
  mkdirSync(join(tmp, 'core', 'sandbox'), { recursive: true });

  const tg = makeTelegram();
  const oc = makeOpenCode(ocBehavior);
  const prov = makeProvider({
    groqList: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'whisper-large-v3'],
    nvidiaList: ['nvidia/nemotron-3-super-120b-a12b', 'z-ai/glm-5.3'],
    probeBehavior: model => probes[model] || null,
  });
  for (const s of [tg.server, oc.server, prov.server]) await new Promise(r => s.listen(0, '127.0.0.1', r));
  const env = {
    ...process.env,
    TELEGRAM_BOT_TOKEN: 'TEST',
    TELEGRAM_API_BASE: `http://127.0.0.1:${tg.server.address().port}`,
    OWNER_TELEGRAM_ID: String(OWNER),
    OPENCODE_SERVER_URL: `http://127.0.0.1:${oc.server.address().port}`,
    OPENCODE_SERVER_CWD: join(tmp, 'core'),
    OPENCODE_BIN: 'true',
    GROQ_API_KEY: 'gsk_test', NVIDIA_API_KEY: 'nvapi_test',
    GROQ_BASE_URL: `http://127.0.0.1:${prov.server.address().port}/groq`,
    NVIDIA_BASE_URL: `http://127.0.0.1:${prov.server.address().port}/nvidia`,
    DEFAULT_PROVIDER: 'groq',
    GROQ_DEFAULT_MODEL: 'openai/gpt-oss-120b',
    NVIDIA_DEFAULT_MODEL: 'nvidia/nemotron-3-super-120b-a12b',
    PUBLIC_BASE_URL: '', STORE_PORT: '0',
    ASK_REMIND_MIN: '6000',
    MODEL_PROBE: 'on',
  };
  const child = spawn(process.execPath, [join(ROOT, 'bot', 'bot.mjs')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.log = '';
  child.stdout.on('data', d => { child.log += d; });
  child.stderr.on('data', d => { child.log += d; });
  return { tmp, tg, oc, prov, child, servers: [tg.server, oc.server, prov.server] };
}

async function killBot(h) {
  if (process.env.DBB_DEBUG) console.log('\n--- bot child log ---\n' + h.child.log.slice(-3000) + '\n--- end bot log ---');
  h.child.kill('SIGKILL');
  await Promise.race([new Promise(r => h.child.once('exit', r)), sleep(3000)]);
  for (const s of h.servers) s.close();
  rmSync(h.tmp, { recursive: true, force: true });
}

// (a) plain text → turn with standing model; reply delivered; NO /start.
test('(a) plain text becomes a turn; reply delivered; no /start needed', async () => {
  snapshotRealState();
  const h = await bootBot({ ocBehavior: { replyFor: () => 'Hello from the agent — noted!' } });
  try {
    await waitFor(() => h.child.log.includes('polling'), 'bot polling');
    h.tg.say('Make a video about monsoon rain');
    const prompt = await waitFor(() => h.oc.state.prompts[0], 'first prompt');
    const promptText = prompt.body.parts.map(p => p.text || '').join('\n');
    assert(promptText.includes('monsoon rain'), 'owner text forwarded');
    assert(promptText.includes('data/memory/preferences.md'), 'first turn of a fresh session carries the orientation note');
    assert(prompt.body.model.providerID === 'groq' && prompt.body.model.modelID === 'openai/gpt-oss-120b', 'standing model used');
    assert(prompt.body.agent === 'video-maker', 'video-maker agent');
    assert(h.oc.state.sessions[0].directory === ROOT, `session directory is the repo root (got ${h.oc.state.sessions[0].directory})`);
    await waitFor(() => h.tg.texts().some(t => t.includes('Hello from the agent')), 'assistant reply delivered to Telegram');
    assert(!h.tg.texts().some(t => t.includes('Press /' + 'start')), 'the old press-start text appears nowhere');
  } finally { await killBot(h); restoreRealState(); }
});

// (b) message during a busy turn is queued, delivered after.
test('(b) a message during a busy turn is queued and delivered after', async () => {
  snapshotRealState();
  const h = await bootBot({ ocBehavior: {
    onPrompt: ({ n }) => n === 1 ? { delayMs: 900, text: 'first done' } : null,
    replyFor: () => 'later reply',
  } });
  try {
    await waitFor(() => h.child.log.includes('polling'), 'bot polling');
    h.tg.say('start the rain video');
    await waitFor(() => h.oc.state.prompts.length === 1, 'first prompt sent');
    h.tg.say('also add thunder sounds');
    await waitFor(() => h.tg.texts().some(t => t.toLowerCase().includes('queued')), 'queued note shown');
    const second = await waitFor(() => h.oc.state.prompts[1], 'queued message delivered as next turn');
    assert(second.body.parts[0].text.includes('thunder'), 'queued text forwarded');
    assert(second.sid === h.oc.state.prompts[0].sid, 'same session');
  } finally { await killBot(h); restoreRealState(); }
});

// (c) /new + /model.
test('(c) /new starts a fresh session; /model switches and the next turn uses it', async () => {
  snapshotRealState();
  const h = await bootBot({ ocBehavior: { replyFor: () => 'ok' } });
  try {
    await waitFor(() => h.child.log.includes('polling'), 'bot polling');
    h.tg.say('first conversation message');
    await waitFor(() => h.oc.state.prompts.length === 1, 'prompt 1');
    const sid1 = h.oc.state.prompts[0].sid;
    await waitFor(() => h.tg.texts().some(t => t === 'ok'), 'reply 1');
    h.tg.say('/new');
    await waitFor(() => h.tg.texts().some(t => t.includes('Fresh conversation')), '/new confirm');
    h.tg.say('second conversation message');
    const p2 = await waitFor(() => h.oc.state.prompts[1], 'prompt 2');
    assert(p2.sid !== sid1, 'fresh session after /new');
    await waitFor(() => h.tg.texts().filter(t => t === 'ok').length === 2, 'reply 2');
    h.tg.say('/model');
    await waitFor(() => h.tg.texts().some(t => t.includes('Current model: groq')), 'picker shows current');
    h.tg.tap('mprov:nvidia');
    await waitFor(() => h.tg.texts().some(t => t.includes('Select a model (NVIDIA')), 'model list shown');
    const models = readState()[OWNER].models;
    h.tg.tap(`mmodel:${models.indexOf('z-ai/glm-5.3')}`);
    await waitFor(() => h.tg.texts().some(t => t.includes('Current model set to nvidia / z-ai/glm-5.3')), 'switch confirmed');
    h.tg.say('third message');
    const p3 = await waitFor(() => h.oc.state.prompts[2], 'prompt 3');
    assert(p3.body.model.providerID === 'nvidia' && p3.body.model.modelID === 'z-ai/glm-5.3', 'next turn uses the new standing model');
  } finally { await killBot(h); restoreRealState(); }
});

// (d) question relay inside a conversation turn.
test('(d) agent question → buttons → answer returns to the session', async () => {
  snapshotRealState();
  let ocRef = null;
  const h = await bootBot({ ocBehavior: {
    onPrompt: ({ sid, n }) => {
      if (n === 1) setTimeout(() => ocRef.state.askQuestion(sid, { id: 'q_1', questions: [{ question: 'Which aspect?', header: 'Aspect', options: [{ label: '9:16', description: 'vertical' }, { label: '16:9', description: 'wide' }] }] }), 150);
      return null;
    },
    replyFor: () => 'working on it',
  } });
  ocRef = h.oc;
  try {
    await waitFor(() => h.child.log.includes('polling'), 'bot polling');
    h.tg.say('make a video about tea');
    const askMsg = await waitFor(() => h.tg.sent().find(m => (m.text || '').includes('Which aspect?')), 'question shown as buttons');
    assert(JSON.stringify(askMsg.reply_markup).includes('q:q_1:0'), 'answer buttons present');
    h.tg.tap('q:q_1:0');
    await waitFor(() => h.oc.state.questions.get('q_1'), 'answer returned to OpenCode');
    assert(JSON.stringify(h.oc.state.questions.get('q_1')) === JSON.stringify([['9:16']]), 'answer payload correct');
  } finally { await killBot(h); restoreRealState(); }
});

// (e) send_file outbox → bot watcher sends; delivery suppresses the nudge.
test('(e) a send_file request in data/outbox is sent by the bot watcher', async () => {
  snapshotRealState();
  const h = await bootBot({ ocBehavior: {
    onPrompt: () => null,
    replyFor: () => 'Your video is ready — sending it now.',
  } });
  const videoPath = join(ROOT, 'data', 'outbox', '.test-video.mp4');
  const reqPath = join(ROOT, 'data', 'outbox', 'test-req.json');
  try {
    await waitFor(() => h.child.log.includes('polling'), 'bot polling');
    h.tg.say('make the rain video');
    await waitFor(() => h.oc.state.prompts.length === 1, 'turn started');
    // Simulate the agent using the send_file tool mid-turn.
    writeFileSync(videoPath, Buffer.alloc(2048, 7));
    writeFileSync(reqPath, JSON.stringify({ path: 'data/outbox/.test-video.mp4', caption: 'Rain video — final' }));
    const send = await waitFor(() => h.tg.calls.find(c => c.method === 'sendVideo'), 'sendVideo call by the watcher');
    assert(send.caption === 'Rain video — final', 'caption carried');
    await waitFor(() => existsSync(join(ROOT, 'data', 'outbox', 'done', 'test-req.json')), 'request marked done');
    await sleep(3200);
    assert(h.oc.state.prompts.length === 1, `no nudge turn when delivery happened (prompts=${h.oc.state.prompts.length})`);
  } finally {
    await killBot(h); restoreRealState();
    rmSync(videoPath, { force: true }); rmSync(reqPath, { force: true });
    rmSync(join(ROOT, 'data', 'outbox', 'done', 'test-req.json'), { force: true });
    rmSync(join(ROOT, 'data', 'outbox', 'done', 'test-req.result.json'), { force: true });
  }
});

// (f) first-turn TPM → switch + persistent notice + retry succeeds.
test('(f) first-turn TPM switches provider with a persistent notice and retries', async () => {
  snapshotRealState();
  let groqPrompts = 0;
  const h = await bootBot({
    ocBehavior: {
      onPrompt: ({ body }) => {
        if (body.model.providerID === 'groq') { groqPrompts += 1; return { error: { status: 429, message: 'Rate limit reached for model openai/gpt-oss-120b: tokens per minute (TPM) limit 8000' } }; }
        return null;
      },
      replyFor: () => 'Switched and done.',
    },
  });
  try {
    await waitFor(() => h.child.log.includes('polling'), 'bot polling');
    h.tg.say('make a video about rivers');
    const retry = await waitFor(() => h.oc.state.prompts.find(p => p.body.model.providerID === 'nvidia'), 'retry on nvidia');
    assert(retry.body.parts[0].text.includes('standing model was switched to nvidia'), 'retry carries the switch note');
    assert(retry.body.parts[0].text.includes('rivers'), 'retry carries the original request');
    assert(groqPrompts === 1, 'exactly one failed groq attempt');
    await waitFor(() => h.tg.texts().some(t => t.includes('⚠️') && t.includes('nvidia / nvidia/nemotron-3-super-120b-a12b')), 'persistent switch notice');
    await waitFor(() => h.tg.texts().some(t => t.includes('Switched and done.')), 'retried reply delivered');
    assert(readState()[OWNER].selection.model === 'nvidia/nemotron-3-super-120b-a12b', 'standing selection persisted as nvidia');
  } finally { await killBot(h); restoreRealState(); }
});

// (g) owner lock.
test('(g) owner lock: strangers are ignored completely', async () => {
  snapshotRealState();
  const h = await bootBot({ ocBehavior: { replyFor: () => 'should never happen' } });
  try {
    await waitFor(() => h.child.log.includes('polling'), 'bot polling');
    h.tg.sayAs(9999, 'hello bot');
    h.tg.sayAs(9999, '/start');
    await sleep(1500);
    assert(h.oc.state.prompts.length === 0, 'no prompt from a stranger');
    assert(h.tg.sent().length === 0, 'no reply to a stranger');
  } finally { await killBot(h); restoreRealState(); }
});

// /start status in the conversational model.
test('/start shows status (model + how to talk), not a form', async () => {
  snapshotRealState();
  const h = await bootBot({ ocBehavior: { replyFor: () => 'x' } });
  try {
    await waitFor(() => h.child.log.includes('polling'), 'bot polling');
    h.tg.say('/start');
    const msg = await waitFor(() => h.tg.texts().find(t => t.includes("I'm awake")), 'status message');
    assert(msg.includes('Current model: groq / openai/gpt-oss-120b'), 'status names the standing model');
    assert(msg.includes('Just talk to me'), 'status explains the conversational way');
    await sleep(500);
    assert(h.oc.state.prompts.length === 0, '/start does not open a turn');
  } finally { await killBot(h); restoreRealState(); }
});

// Voice intake: transcribed and forwarded as a turn.
test('voice message is saved, transcribed and forwarded as a turn', async () => {
  snapshotRealState();
  const h = await bootBot({ ocBehavior: { replyFor: () => 'Got your voice script.' } });
  const inboxDir = join(ROOT, 'data', 'inbox');
  const before = new Set(existsSync(inboxDir) ? readdirSync(inboxDir) : []);
  try {
    await waitFor(() => h.child.log.includes('polling'), 'bot polling');
    h.tg.voice();
    const prompt = await waitFor(() => h.oc.state.prompts[0], 'voice turn forwarded', 45000);
    const text = prompt.body.parts.map(p => p.text || '').join('\n');
    assert(text.includes('This is my recorded narration.'), `transcript forwarded (got: ${text.slice(0, 200)})`);
    assert(text.includes('data/inbox/') && text.includes('voice script'), 'audio path + voice-script note forwarded');
    const m = text.match(/data\/inbox\/\S+?voice\.ogg/);
    assert(m && existsSync(join(ROOT, m[0])), 'audio file saved into data/inbox');
  } finally {
    await killBot(h); restoreRealState();
    if (existsSync(inboxDir)) for (const f of readdirSync(inboxDir)) {
      if (!before.has(f)) rmSync(join(inboxDir, f), { recursive: true, force: true });
    }
  }
});

// Amendment A3: claim without delivery → one nudge turn.
test('claim without delivery triggers exactly one nudge turn', async () => {
  snapshotRealState();
  const h = await bootBot({ ocBehavior: {
    onPrompt: ({ n }) => n === 1 ? { text: 'Done! I rendered final.mp4 and sent it to you.' } : { text: 'You are right — sending it now for real.' },
    replyFor: () => 'unused',
  } });
  try {
    await waitFor(() => h.child.log.includes('polling'), 'bot polling');
    h.tg.say('make the video');
    const nudge = await waitFor(() => h.oc.state.prompts[1], 'nudge turn sent', 20000);
    assert(nudge.body.parts[0].text.includes('nothing was sent to the chat'), 'nudge text is the system note');
    await waitFor(() => h.tg.texts().some(t => t.includes('sending it now for real')), 'agent follow-up delivered');
    await sleep(3500);
    assert(h.oc.state.prompts.length === 2, `at most one nudge (prompts=${h.oc.state.prompts.length})`);
  } finally { await killBot(h); restoreRealState(); }
});

// (h) Session lifecycle: a final=true delivery rotates the session; the
// next message opens a FRESH session whose first prompt carries the
// memory brief (full preferences + last 10 index lines only).
test('(h) final delivery rotates the session; next session opens with the memory brief', async () => {
  snapshotRealState();
  const indexLines = Array.from({ length: 12 }, (_, i) => `- 2026-10-${String(i + 1).padStart(2, '0')} — Video ${String(i + 1).padStart(2, '0')} — core/sandbox/v${String(i + 1).padStart(2, '0')}/`).join('\n') + '\n';
  seedMemory('- Always 9:16.\n- Default style: line\n- He writes in Bengali mostly.\n', indexLines);
  const h = await bootBot({ ocBehavior: { replyFor: () => 'Working on it.' } });
  const videoPath = join(ROOT, 'data', 'outbox', '.test-final.mp4');
  const reqPath = join(ROOT, 'data', 'outbox', 'final-req.json');
  try {
    await waitFor(() => h.child.log.includes('polling'), 'bot polling');
    h.tg.say('make the rain video');
    const p1 = await waitFor(() => h.oc.state.prompts[0], 'first prompt');
    const sid1 = p1.sid;
    const firstText = p1.body.parts.map(x => x.text || '').join('\n');
    assert(firstText.includes('Your memory from previous sessions'), 'first session also briefed (memory was seeded)');
    assert(firstText.includes('Always 9:16'), 'preferences in the brief');
    // The agent delivers the FINISHED video: send_file with final=true.
    writeFileSync(videoPath, Buffer.alloc(2048, 7));
    writeFileSync(reqPath, JSON.stringify({ path: 'data/outbox/.test-final.mp4', caption: 'Rain — final', final: true }));
    await waitFor(() => h.tg.calls.find(c => c.method === 'sendVideo'), 'final video sent');
    await waitFor(() => (readState()[OWNER].pastSessions || []).length === 1, 'session archived into pastSessions');
    assert(readState()[OWNER].pastSessions[0].id === sid1, 'the archived session is the one that delivered');
    assert(!readState()[OWNER].sessionId, 'no live session after rotation');
    // Next message → fresh session + memory brief.
    h.tg.say('now make one about tea gardens');
    const p2 = await waitFor(() => h.oc.state.prompts[1], 'second prompt');
    assert(p2.sid !== sid1, 'fresh session after the final delivery');
    const t2 = p2.body.parts.map(x => x.text || '').join('\n');
    assert(t2.includes('Your memory from previous sessions — preferences and recent work'), 'memory brief intro present');
    assert(t2.includes('Default style: line'), 'full preferences carried into the new session');
    assert(t2.includes('Video 12') && t2.includes('Video 03'), 'recent index lines present');
    assert(!t2.includes('Video 01') && !t2.includes('Video 02'), 'only the last 10 index lines are briefed');
    assert(t2.includes('tea gardens'), 'the new request itself is in the prompt');
  } finally {
    await killBot(h); restoreRealState();
    rmSync(videoPath, { force: true }); rmSync(reqPath, { force: true });
    rmSync(join(ROOT, 'data', 'outbox', 'done', 'final-req.json'), { force: true });
    rmSync(join(ROOT, 'data', 'outbox', 'done', 'final-req.result.json'), { force: true });
  }
});

// (i) Without a final delivery, the session simply stays open.
test('(i) without a final delivery, consecutive messages keep the same session', async () => {
  snapshotRealState();
  const h = await bootBot({ ocBehavior: { replyFor: () => 'noted' } });
  try {
    await waitFor(() => h.child.log.includes('polling'), 'bot polling');
    h.tg.say('first message of a job');
    await waitFor(() => h.oc.state.prompts.length === 1, 'prompt 1');
    await waitFor(() => h.tg.texts().some(t => t === 'noted'), 'reply 1');
    h.tg.say('a revision to the same job');
    const p2 = await waitFor(() => h.oc.state.prompts[1], 'prompt 2');
    assert(p2.sid === h.oc.state.prompts[0].sid, 'same session across messages');
    assert(!(readState()[OWNER].pastSessions || []).length, 'nothing archived');
  } finally { await killBot(h); restoreRealState(); }
});

// Migration: old-shape state file is tolerated, selection kept.
test('old-shape state file is tolerated and its selection kept', async () => {
  snapshotRealState();
  writeFileSync(REAL_STATE, JSON.stringify({ [OWNER]: {
    step: 'confirm', draft: { mode: 'topic' }, activeJobId: 'job-9', statusMsgId: 5,
    selection: { provider: 'nvidia', model: 'z-ai/glm-5.3' },
  } }));
  const h = await bootBot({ ocBehavior: { replyFor: () => 'migration ok' } });
  try {
    await waitFor(() => h.child.log.includes('polling'), 'bot polling');
    h.tg.say('hello after upgrade');
    const prompt = await waitFor(() => h.oc.state.prompts[0], 'turn runs despite old state');
    assert(prompt.body.model.providerID === 'nvidia' && prompt.body.model.modelID === 'z-ai/glm-5.3', 'old selection kept and used');
    await waitFor(() => h.tg.texts().some(t => t.includes('migration ok')), 'reply delivered');
  } finally { await killBot(h); restoreRealState(); }
});

let failed = 0;
for (const t of tests) {
  try { await t.fn(); console.log(`  ✓ ${t.name}`); }
  catch (e) { failed += 1; console.log(`  ✗ ${t.name}\n      ${e.message}`); }
}
if (failed) throw new Error(`${failed} flow test(s) failed`);
console.log(`flow: ${tests.length} conversation tests passed`);
