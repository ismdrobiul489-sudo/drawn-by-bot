// Flow test: run the real bot against a MOCK Telegram API (local server) and
// drive /start → mode → content → provider → model → style → aspect → voice →
// confirm with canned updates. Asserts the keyboards/texts the bot sends.
// Groq /models is mocked too. The queued job will fail at the OpenCode step
// (no opencode/keys here) — that graceful failure is expected and cleaned up.
import assert from 'node:assert';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const sent = [];
let pending = [];
let updateId = 0;
const upd = u => { pending.push({ update_id: ++updateId, ...u }); };
const msg = text => ({ message: { message_id: updateId + 500, chat: { id: 42 }, from: { id: 42 }, text } });
const cb = data => ({ callback_query: { id: `q${updateId}`, from: { id: 42 }, message: { chat: { id: 42 }, message_id: 1 }, data } });

const server = createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url;
    if (url.endsWith('/models')) { // Groq /models mock
      res.end(JSON.stringify({ data: [
        { id: 'openai/gpt-oss-120b' }, { id: 'whisper-large-v3' },
        { id: 'canopylabs/orpheus-v1-english' }, { id: 'qwen/qwen3.8-27b' },
      ] }));
      return;
    }
    const method = url.split('/').pop();
    let params = {};
    try { params = JSON.parse(body || '{}'); } catch { /* multipart */ }
    if (method === 'getUpdates') {
      const out = pending; pending = [];
      res.end(JSON.stringify({ ok: true, result: out }));
      return;
    }
    if (method === 'sendMessage') sent.push(params);
    res.end(JSON.stringify({ ok: true, result: { message_id: 1000 + sent.length } }));
  });
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;

const env = {
  ...process.env,
  TELEGRAM_BOT_TOKEN: 'test-token',
  TELEGRAM_API_BASE: `http://127.0.0.1:${port}`,
  OWNER_TELEGRAM_ID: '42',
  GROQ_API_KEY: 'test-key',
  GROQ_BASE_URL: `http://127.0.0.1:${port}/groq`,
  OPENCODE_BIN: '/nonexistent/opencode', // job must fail fast & gracefully in this env
  STORE_PORT: '0',
  MODELS_CACHE_TTL_SEC: '900',
};
const bot = spawn('node', ['bot/bot.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
bot.stderr.on('data', d => process.stderr.write(`[bot] ${d}`));

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(pred, what, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return;
    await sleep(150);
  }
  throw new Error(`timeout waiting for: ${what}\nsent so far: ${JSON.stringify(sent.map(s => s.text?.slice(0, 60)))}`);
}
const hasText = frag => () => sent.some(s => (s.text || '').includes(frag));
const lastKb = frag => sent.filter(s => (s.text || '').includes(frag)).pop()?.reply_markup;

try {
  upd(msg('/start'));
  await waitFor(hasText('কী দেবেন?'), 'mode keyboard');
  assert.ok(JSON.stringify(lastKb('কী দেবেন?')).includes('mode:topic'));

  // A stranger is ignored:
  pending.push({ update_id: ++updateId, message: { message_id: 1, chat: { id: 99 }, from: { id: 99 }, text: '/start' } });
  await sleep(600);
  assert.ok(!sent.some(s => s.chat_id === 99), 'stranger must be ignored');

  upd(cb('mode:topic'));
  await waitFor(hasText('Topic লিখে পাঠান'), 'topic prompt');
  upd(msg('test topic about rain'));
  await waitFor(hasText('কোন provider'), 'provider keyboard');
  upd(cb('prov:groq'));
  await waitFor(hasText('Model সিলেক্ট করুন'), 'model list');
  const modelKb = JSON.stringify(lastKb('Model সিলেক্ট করুন'));
  assert.ok(modelKb.includes('gpt-oss-120b'), 'dynamic model button present');
  assert.ok(!modelKb.includes('whisper'), 'whisper filtered out of chat models');

  upd(cb('model:0'));
  await waitFor(hasText('Style সিলেক্ট করুন'), 'style list');
  assert.ok(JSON.stringify(lastKb('Style সিলেক্ট করুন')).includes('style:line'));

  upd(cb('style:line'));
  await waitFor(hasText('Aspect ratio'), 'aspect');
  upd(cb('aspect:9:16'));
  await waitFor(hasText('কোন কণ্ঠে'), 'voice list (fallback ok)');
  upd(cb('voice:0'));
  await waitFor(hasText('Job summary'), 'confirm card');
  const summary = sent.filter(s => (s.text || '').includes('Job summary')).pop().text;
  assert.ok(summary.includes('line') && summary.includes('9:16') && summary.includes('gpt-oss-120b'));

  upd(cb('confirm'));
  await waitFor(hasText('queue'), 'queued message');
  console.log('  ✓ flow: /start → mode → content → provider → live models → style → aspect → voice → confirm → queue');
  console.log('  ✓ owner-only lock verified (stranger ignored)');
} finally {
  bot.kill('SIGKILL');
  server.close();
  // Clean the sandbox job folder the (expected-to-fail) test job created.
  const sandbox = join(ROOT, 'core', 'sandbox');
  if (existsSync(sandbox)) {
    for (const d of readdirSync(sandbox)) {
      if (d.endsWith('-test-topic-about-rain')) rmSync(join(sandbox, d), { recursive: true, force: true });
    }
  }
  rmSync(join(ROOT, 'data'), { recursive: true, force: true });
}
