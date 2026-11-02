// makeflow group — the 🎬 Make-a-video READY-MADE flow, end to end
// against mocks. Spawns the real bot (bot/bot.mjs) as a child process
// with a mock Telegram API, a mock OpenCode serve, and mock provider
// APIs — the same harness shape as tests/flow.test.mjs.
//
// Covers: (1) /start 🎬 button → topic text → style tap → aspect tap →
// TTS tap → conversation.submit received the EXACT composed brief, and
// the flow consumed the topic text (no stray turn); (2) /make → own-
// voice choice → expectation marked in state → the next voice message
// submits with the brief prepended to the transcript turn; (3) /cancel
// mid-flow clears the flow and plain text is a normal turn again.
//
// data/ is resolved from the REPO root, so the real data/state.json is
// snapshotted before boot and restored after (same as flow.test.mjs).
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

// ── Mock provider (models + probe + whisper transcription) ─────────────────
function makeProvider() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const reply = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json ?? {})); };
    if (req.method === 'GET' && url.pathname === '/groq/models') return reply(200, { data: [{ id: 'openai/gpt-oss-120b' }, { id: 'whisper-large-v3' }] });
    if (req.method === 'GET' && url.pathname === '/nvidia/models') return reply(200, { data: [{ id: 'nvidia/nemotron-3-super-120b-a12b' }] });
    if (req.method === 'POST' && /^\/(groq|nvidia)\/chat\/completions$/.test(url.pathname)) {
      await readJsonBody(req);
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
  return { server };
}

// ── Mock OpenCode serve (sessions + scripted instant replies) ──────────────
function makeOpenCode() {
  const state = { sessions: [], prompts: [], subscribers: new Set() };
  const emit = ev => { for (const res of [...state.subscribers]) { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch {} } };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (req.method === 'GET' && p === '/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      if (res.flushHeaders) res.flushHeaders();
      state.subscribers.add(res);
      req.on('close', () => state.subscribers.delete(res));
      return;
    }
    const reply = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json ?? {})); };
    if (req.method === 'GET' && p === '/global/health') return reply(200, { healthy: true, version: 'mock' });
    if (req.method === 'GET' && p === '/session/status') return reply(200, {});
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
      setTimeout(() => {
        const mid = `msg_${state.prompts.length}_${Date.now()}`;
        emit({ type: 'message.part.delta', properties: { sessionID: sid, messageID: mid, partID: 'p1', field: 'text', delta: 'Agent reply.' } });
        emit({ type: 'session.idle', properties: { sessionID: sid } });
      }, 30);
      return reply(204, {});
    }
    if (req.method === 'POST' && p.includes('/abort')) return reply(200, true);
    return reply(404, { error: 'no route ' + req.method + ' ' + p });
  });
  return { server, state };
}

// ── Mock Telegram ───────────────────────────────────────────────────────────
function makeTelegram() {
  const calls = [];
  const updates = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname.startsWith('/file/')) {
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(tinyWav());
      return;
    }
    const body = await readJsonBody(req);
    const reply = (json) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
    const method = url.pathname.split('/').pop();
    if (method === 'getUpdates') {
      let mine = updates.filter(u => u.update_id >= (body.offset || 0)).slice(0, 10);
      if (!mine.length) {
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
    voice: () => push({ message: { message_id: uid, chat: { id: OWNER }, from: { id: OWNER }, voice: { file_id: 'voice-file-1', duration: 3, mime_type: 'audio/ogg' } } }),
    tap: data => push({ callback_query: { id: `cb${uid}`, from: { id: OWNER }, message: { message_id: 1, chat: { id: OWNER } }, data } }),
    sent: () => calls.filter(c => c.method === 'sendMessage'),
    texts: () => calls.filter(c => c.method === 'sendMessage').map(c => c.text || ''),
    markupHas: needle => calls.some(c => c.method === 'sendMessage' && JSON.stringify(c.reply_markup || {}).includes(needle)),
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

// ── Real-state snapshot/restore (same discipline as flow.test.mjs) ─────────
const REAL_STATE = join(ROOT, 'data', 'state.json');
const REAL_PENDING = join(ROOT, 'data', 'pending.json');
const REAL_LOCK = join(ROOT, 'data', 'bot.lock');
const REAL_MEMORY = join(ROOT, 'data', 'memory');
let savedRealState = null, savedRealPending = null, savedRealLock = null, savedMemory = null;
function snapshotRealState() {
  savedRealState = existsSync(REAL_STATE) ? readFileSync(REAL_STATE, 'utf8') : null;
  savedRealPending = existsSync(REAL_PENDING) ? readFileSync(REAL_PENDING, 'utf8') : null;
  savedRealLock = existsSync(REAL_LOCK) ? readFileSync(REAL_LOCK, 'utf8') : null;
  rmSync(REAL_LOCK, { force: true });
  savedMemory = {};
  for (const f of ['preferences.md', 'index.md']) {
    const p = join(REAL_MEMORY, f);
    savedMemory[f] = existsSync(p) ? readFileSync(p, 'utf8') : null;
    rmSync(p, { force: true });
  }
  rmSync(REAL_STATE, { force: true });
  rmSync(REAL_PENDING, { force: true });
}
function restoreRealState() {
  if (savedRealState === null) rmSync(REAL_STATE, { force: true }); else writeFileSync(REAL_STATE, savedRealState);
  if (savedRealPending === null) rmSync(REAL_PENDING, { force: true }); else writeFileSync(REAL_PENDING, savedRealPending);
  if (savedRealLock === null) rmSync(REAL_LOCK, { force: true }); else writeFileSync(REAL_LOCK, savedRealLock);
  if (savedMemory) for (const [f, content] of Object.entries(savedMemory)) {
    const p = join(REAL_MEMORY, f);
    if (content === null) rmSync(p, { force: true });
    else { mkdirSync(REAL_MEMORY, { recursive: true }); writeFileSync(p, content); }
  }
}
const readState = () => JSON.parse(readFileSync(REAL_STATE, 'utf8'));

async function bootBot() {
  const tmp = mkdtempSync(join(tmpdir(), 'dbb-makeflow-'));
  mkdirSync(join(tmp, 'core', 'sandbox'), { recursive: true });
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

const briefFor = ({ topic, style, aspect, voiceLine }) => [
  '[New video job — choices already made by the owner, do not ask about them again]',
  `Topic: ${topic}`,
  `Style: ${style}`,
  `Aspect: ${aspect}`,
  `Voice: ${voiceLine}`,
  'Narration language: same as the topic (unless the owner said otherwise).',
  'Make the video end to end. If anything else material is missing, ask in ONE short plain-text question and end your turn — never use the question tool for style, aspect or voice.',
].join('\n');

// (1) 🎬 button path → TTS → the exact brief reaches the conversation.
test('(1) /start 🎬 → topic → style → aspect → TTS submits the exact brief', async () => {
  snapshotRealState();
  const h = await bootBot();
  try {
    await waitFor(() => h.child.log.includes('polling'), 'bot polling');
    h.tg.say('/start');
    await waitFor(() => h.tg.markupHas('make:start'), '/start carries the 🎬 Make a video button');
    h.tg.tap('make:start');
    await waitFor(() => h.tg.texts().some(t => t.includes('What should the video be about?')), 'topic ask');
    h.tg.say('How rain forms');
    await waitFor(() => h.tg.markupHas('make:style:paper-cutout'), 'style buttons shown');
    assert(h.oc.state.prompts.length === 0, 'the topic text was consumed by the flow, not submitted as a turn');
    const csAfterTopic = readState()[OWNER];
    assert(csAfterTopic.make?.stage === 'style' && csAfterTopic.make?.topic === 'How rain forms', 'flow state holds the topic at the style stage');
    h.tg.tap('make:style:paper-cutout');
    await waitFor(() => h.tg.markupHas('make:aspect:9:16'), 'aspect buttons shown');
    h.tg.tap('make:aspect:9:16');
    await waitFor(() => h.tg.markupHas('make:voice:tts'), 'voice buttons shown');
    h.tg.tap('make:voice:tts');
    const prompt = await waitFor(() => h.oc.state.prompts[0], 'brief submitted as a turn');
    const promptText = prompt.body.parts.map(p => p.text || '').join('\n');
    const expected = briefFor({ topic: 'How rain forms', style: 'paper-cutout', aspect: '9:16', voiceLine: 'TTS narration' });
    assert(promptText.includes(expected), `prompt carries the EXACT brief.\n--- expected ---\n${expected}\n--- prompt ---\n${promptText.slice(0, 1200)}`);
    await waitFor(() => h.tg.texts().some(t => t.includes('✅ Brief sent to the agent') && t.includes('paper-cutout') && t.includes('9:16')), 'owner confirmation echoes the choices');
    assert(readState()[OWNER].make === null, 'flow state cleared after the brief was sent');
  } finally { await killBot(h); restoreRealState(); }
});

// (2) /make → own-voice choice → next voice message submits with the brief.
test('(2) /make → record-my-voice → the next voice message submits with the brief', async () => {
  snapshotRealState();
  const h = await bootBot();
  const inboxDir = join(ROOT, 'data', 'inbox');
  const before = new Set(existsSync(inboxDir) ? readdirSync(inboxDir) : []);
  try {
    await waitFor(() => h.child.log.includes('polling'), 'bot polling');
    h.tg.say('/make');
    await waitFor(() => h.tg.texts().some(t => t.includes('What should the video be about?')), 'topic ask');
    h.tg.say('My morning in the village');
    await waitFor(() => h.tg.markupHas('make:style:line'), 'style buttons shown');
    h.tg.tap('make:style:line');
    await waitFor(() => h.tg.markupHas('make:aspect:16:9'), 'aspect buttons shown');
    h.tg.tap('make:aspect:16:9');
    await waitFor(() => h.tg.markupHas('make:voice:own'), 'voice buttons shown');
    h.tg.tap('make:voice:own');
    await waitFor(() => h.tg.texts().some(t => t.includes('Now send your voice message')), 'voice recording requested');
    const cs = readState()[OWNER];
    assert(cs.make === null, 'flow closed after the voice choice');
    assert(cs.expectVoice?.topic === 'My morning in the village' && cs.expectVoice?.style === 'line' && cs.expectVoice?.aspect === '16:9', 'voice-script expectation marked in state');
    h.tg.voice();
    const prompt = await waitFor(() => h.oc.state.prompts[0], 'voice-script turn submitted', 45000);
    const promptText = prompt.body.parts.map(p => p.text || '').join('\n');
    const expected = briefFor({ topic: 'My morning in the village', style: 'line', aspect: '16:9', voiceLine: "owner's own recorded narration (voice script)" });
    assert(promptText.includes(expected), `voice turn carries the brief.\n--- expected ---\n${expected}\n--- prompt ---\n${promptText.slice(0, 1200)}`);
    assert(promptText.includes('This is my recorded narration.'), 'transcript follows the brief');
    assert(promptText.includes('data/inbox/'), 'audio path included');
    assert(readState()[OWNER].expectVoice === null, 'expectation consumed by the voice message');
  } finally {
    await killBot(h); restoreRealState();
    if (existsSync(inboxDir)) for (const f of readdirSync(inboxDir)) {
      if (!before.has(f)) rmSync(join(inboxDir, f), { recursive: true, force: true });
    }
  }
});

// (3) /cancel mid-flow clears it; plain text is a normal turn again.
test('(3) /cancel mid-flow clears the flow', async () => {
  snapshotRealState();
  const h = await bootBot();
  try {
    await waitFor(() => h.child.log.includes('polling'), 'bot polling');
    h.tg.tap('make:start');
    await waitFor(() => h.tg.texts().some(t => t.includes('What should the video be about?')), 'topic ask');
    h.tg.say('A trip to the moon');
    await waitFor(() => h.tg.markupHas('make:style:risograph'), 'style buttons shown');
    h.tg.say('/cancel');
    await waitFor(() => h.tg.texts().some(t => t.includes('Video setup cancelled')), 'cancel confirmation');
    assert(readState()[OWNER].make === null, 'flow state cleared by /cancel');
    assert(h.oc.state.prompts.length === 0, 'nothing was submitted from the cancelled flow');
    h.tg.say('just chatting now');
    const prompt = await waitFor(() => h.oc.state.prompts[0], 'plain text is a normal turn again');
    assert(prompt.body.parts.map(p => p.text || '').join('\n').includes('just chatting now'), 'post-cancel text reaches the conversation');
  } finally { await killBot(h); restoreRealState(); }
});

let failed = 0;
for (const t of tests) {
  try { await t.fn(); console.log(`  ✓ ${t.name}`); }
  catch (e) { failed += 1; console.log(`  ✗ ${t.name}\n      ${e.message}`); }
}
if (failed) throw new Error(`${failed} makeflow test(s) failed`);
console.log(`makeflow: ${tests.length} ready-made flow tests passed`);
