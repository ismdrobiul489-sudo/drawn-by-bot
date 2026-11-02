// quietdelivery group — the bridge enforces quiet delivery (FIX A).
//
// Live 2026-11-02: on the first 🎬 run, the agent's internal
// deliberation ("Let me set up the job folder…", "Now I need to check
// the paper.js…", a dozen of them) flooded the owner's Telegram as
// separate chat messages — the video-maker.md no-narration instruction
// did NOT stop it. The bridge now accumulates streamed text silently
// and, at turn settle, delivers ONLY the turn's final assistant
// message. Bot-generated progress pings (PROGRESS_PING_SEC, 0.3 s
// here) are the only mid-turn heartbeat.
//
// Driven through the REAL AgentServer + Conversation + Outbox classes
// against one mock HTTP server (providers + OpenCode), same harness
// shape as transient503.test.mjs. The mock's session store serves
// every message, so the settle-time final-pick runs on the store path
// (dedupe against the stream included).
//
// Asserts:
//  (a) a turn producing 3 intermediate messages + 1 final message
//      delivers ONLY the final text, exactly once; intermediates
//      never reach Telegram; progress pings DO fire mid-turn.
//  (b) a send_file request arriving mid-turn is still sent by the
//      outbox watcher, the final (claim) text is delivered, and the
//      claims-without-delivery nudge does NOT fire.
//  (c) a turn whose agent says nothing still ends with the plain ℹ️
//      empty-turn notice — progress pings do not count as delivered
//      text.
import { createServer } from 'node:http';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.GROQ_API_KEY = 'gsk_quiet_test';
process.env.NVIDIA_API_KEY = 'nvapi_quiet_test';
process.env.DEFAULT_PROVIDER = 'nvidia';
process.env.GROQ_DEFAULT_MODEL = 'openai/gpt-oss-120b';
process.env.NVIDIA_DEFAULT_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
process.env.MODEL_PROBE = 'on';
process.env.OPENCODE_DRIVER = 'serve';
process.env.OPENCODE_TIMEOUT_MIN = '1';
process.env.PROGRESS_PING_SEC = '0.3';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const OUTBOX_DIR = join(ROOT, 'data', 'outbox');
const VIDEO_PATH = join(OUTBOX_DIR, '.quiet-test.mp4');
const REQ_PATH = join(OUTBOX_DIR, 'quiet-req.json');
const cleanupOutbox = () => {
  rmSync(VIDEO_PATH, { force: true });
  rmSync(REQ_PATH, { force: true });
  rmSync(join(OUTBOX_DIR, 'done', 'quiet-req.json'), { force: true });
  rmSync(join(OUTBOX_DIR, 'done', 'quiet-req.result.json'), { force: true });
};
cleanupOutbox(); // a crashed earlier run must not poison this one (the watcher counts by filename)

const seen = { prompts: [] };
const stores = new Map(); // sid -> raw OpenCode message list
let sessionSeq = 0;
let eventRes = null;
let script = null; // set by the test before each submit

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
    return readBody(() => { const sid = `ses_q${++sessionSeq}`; stores.set(sid, []); json(200, { id: sid, slug: 'x', title: 'test', time: { created: 1, updated: 1 } }); });
  }
  const msgMatch = p.match(/^\/session\/([^/]+)\/message$/);
  if (msgMatch && req.method === 'GET') return json(200, stores.get(msgMatch[1]) || []);
  if (/^\/session\/[^/]+$/.test(p) && req.method === 'GET') return json(200, { id: p.split('/')[2] });
  if (p.includes('/prompt_async')) {
    return readBody(b => {
      const sid = p.split('/')[2];
      seen.prompts.push({ sid, body: JSON.parse(b || '{}') });
      json(204, {});
      const sc = script || { messages: [], idleAtMs: 60 };
      if (sc.onPrompt) { try { sc.onPrompt(); } catch (e) { console.error('[quietdelivery mock] onPrompt failed:', e.message); } }
      for (const m of sc.messages || []) {
        setTimeout(() => {
          stores.get(sid)?.push({
            info: { id: m.mid, role: 'assistant', time: { created: Date.now() } },
            parts: [{ type: 'text', text: m.text, messageID: m.mid }],
          });
          emit({ type: 'message.part.delta', properties: { sessionID: sid, messageID: m.mid, partID: 'p1', field: 'text', delta: m.text } });
        }, m.atMs);
      }
      setTimeout(() => emit({ type: 'session.idle', properties: { sessionID: sid } }), sc.idleAtMs ?? 60);
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
const { Conversation, PROGRESS_PING_TEXT } = await import('../bot/conversation.mjs');
const { Outbox } = await import('../bot/outbox.mjs');

const tgLog = { msgs: [], videos: [] };
const tg = {
  sendMessage: async (chatId, text) => { tgLog.msgs.push({ chatId, text }); return { message_id: tgLog.msgs.length }; },
  sendChatAction: async () => true,
  sendVideo: async (chatId, path, caption) => { tgLog.videos.push({ chatId, path, caption }); return { message_id: 1 }; },
  sendPhoto: async () => ({}),
  sendDocument: async () => ({}),
};
const textsFor = id => tgLog.msgs.filter(m => m.chatId === id).map(m => m.text);

const outbox = new Outbox({ tg, chatId: 778, intervalMs: 250 });
outbox.start();

const state = {};
const chatState = id => (state[id] ||= { step: 'idle' });
const conv = new Conversation({
  tg, agent: new AgentServer(),
  chatState, saveState: () => {},
  selectionOf: cs => (cs.selection ??= { provider: 'nvidia', model: 'nvidia/nemotron-3-ultra-550b-a55b' }),
  setSelection: (cs, sel) => { cs.selection = { ...sel }; },
  sessionDirectory: '/tmp',
  settleMs: 1500,
  outbox,
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, what, ms = 30000) {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await sleep(60); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

try {
  // ── (a) deliberation flood → only the final message is delivered ──────
  const INTERMEDIATES = [
    'Let me set up the job folder and write the script first.',
    'Now I need to check the paper.js to understand the Paper module functions.',
    'Let me check the core folder for the engine entry point.',
  ];
  const FINAL = 'Your paper-boat video is ready for review — tell me if you want any changes.';
  script = {
    messages: [
      { mid: 'm_i1', text: INTERMEDIATES[0], atMs: 100 },
      { mid: 'm_i2', text: INTERMEDIATES[1], atMs: 300 },
      { mid: 'm_i3', text: INTERMEDIATES[2], atMs: 500 },
      { mid: 'm_fin', text: FINAL, atMs: 700 },
    ],
    idleAtMs: 1500,
  };
  await conv.submit(777, 'How to make a paper boat, step by step');
  await waitFor(() => textsFor(777).includes(FINAL), '(a) final message delivered');
  await sleep(700); // let any wrongly-flushed stragglers land before counting
  assert(textsFor(777).filter(t => t === FINAL).length === 1, '(a) the final message is delivered exactly once');
  for (const t of INTERMEDIATES) {
    assert(!textsFor(777).some(x => x.includes(t)), `(a) intermediate deliberation never reached Telegram: "${t.slice(0, 40)}…"`);
  }
  assert(textsFor(777).filter(t => t === PROGRESS_PING_TEXT).length >= 1, '(a) bot progress pings fired while the turn ran');
  console.log('  ✓ (a) 3 deliberation messages dropped; only the final message delivered, once; pings fired');

  // ── (b) send_file mid-turn still goes through; claim + delivery = no nudge
  script = {
    onPrompt: () => {
      writeFileSync(VIDEO_PATH, Buffer.alloc(2048, 7));
      writeFileSync(REQ_PATH, JSON.stringify({ path: 'data/outbox/.quiet-test.mp4', caption: 'Boat preview' }));
    },
    messages: [{ mid: 'm_b1', text: 'All done — I sent the file to you.', atMs: 150 }],
    idleAtMs: 400,
  };
  const promptsBeforeB = seen.prompts.length;
  await conv.submit(778, 'make the boat preview');
  await waitFor(() => tgLog.videos.length === 1, '(b) outbox watcher sent the file');
  assert(tgLog.videos[0].caption === 'Boat preview', '(b) caption carried');
  await waitFor(() => textsFor(778).includes('All done — I sent the file to you.'), '(b) final claim text delivered');
  await sleep(2500); // settle (1.5 s) + margin: a nudge would have prompted by now
  assert(seen.prompts.length - promptsBeforeB === 1, `(b) no nudge turn when the delivery happened (prompts=${seen.prompts.length - promptsBeforeB})`);
  assert(existsSync(join(OUTBOX_DIR, 'done', 'quiet-req.json')), '(b) request marked done');
  console.log('  ✓ (b) send_file delivery went through mid-turn; claim text delivered; no nudge');

  // ── (c) a silent turn still gets the empty notice — pings don't count ──
  script = { messages: [], idleAtMs: 1100 };
  await conv.submit(779, 'just think quietly');
  await waitFor(() => textsFor(779).some(t => t.includes('That turn finished without any reply')), '(c) empty-turn notice posted despite the pings');
  assert(textsFor(779).filter(t => t === PROGRESS_PING_TEXT).length >= 1, '(c) pings fired during the silent turn');
  console.log('  ✓ (c) silent turn → pings fired, yet the empty-turn notice still posted (pings are not deliveries)');
} finally {
  outbox.stop();
  server.close();
  cleanupOutbox();
}
console.log('quietdelivery: passed');
process.exit(0);
