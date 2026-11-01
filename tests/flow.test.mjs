// Flow test: run the real bot against a MOCK Telegram API (local server) and
// drive /start → mode → content → provider → model → style → aspect → voice →
// confirm with canned updates. Asserts the keyboards/texts the bot sends.
// Groq /models is mocked too. The queued job will fail at the OpenCode step
// (no opencode/keys here) — that graceful failure is expected and cleaned up.
import assert from 'node:assert';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const sent = [];
const calls = []; // every JSON API call the bot makes: { method, params }
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
    calls.push({ method, params });
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
const countText = frag => sent.filter(s => (s.text || '').includes(frag)).length;

try {
  upd(msg('/start'));
  await waitFor(hasText('What will you give'), 'mode keyboard');
  assert.ok(JSON.stringify(lastKb('What will you give')).includes('mode:topic'));

  // (a) The bot registered its command menu with Telegram at boot.
  const sc = calls.find(c => c.method === 'setMyCommands');
  assert.ok(sc, 'setMyCommands was called at boot');
  assert.deepEqual(sc.params.commands, [
    { command: 'start', description: 'Start the video maker' },
    { command: 'new', description: 'Start a new video job' },
    { command: 'topic', description: 'New video from a topic' },
    { command: 'script', description: 'New video from your script' },
    { command: 'voice', description: 'Make a video from your voice script' },
    { command: 'cancel', description: 'Cancel the current setup' },
    { command: 'help', description: 'How this bot works' },
  ]);
  console.log('  ✓ setMyCommands registered the 7-command menu at boot');

  // A stranger is ignored:
  pending.push({ update_id: ++updateId, message: { message_id: 1, chat: { id: 99 }, from: { id: 99 }, text: '/start' } });
  await sleep(600);
  assert.ok(!sent.some(s => s.chat_id === 99), 'stranger must be ignored');

  upd(cb('mode:topic'));
  await waitFor(hasText('Type your topic'), 'topic prompt');
  upd(msg('test topic about rain'));
  await waitFor(hasText('Which provider'), 'provider keyboard');
  upd(cb('prov:groq'));
  await waitFor(hasText('Select a model'), 'model list');
  const modelKb = JSON.stringify(lastKb('Select a model'));
  assert.ok(modelKb.includes('gpt-oss-120b'), 'dynamic model button present');
  assert.ok(!modelKb.includes('whisper'), 'whisper filtered out of chat models');

  upd(cb('model:0'));
  await waitFor(hasText('Select a style'), 'style list');
  assert.ok(JSON.stringify(lastKb('Select a style')).includes('style:line'));

  upd(cb('style:line'));
  await waitFor(hasText('Aspect ratio'), 'aspect');
  upd(cb('aspect:9:16'));
  await waitFor(hasText('Which voice'), 'voice list (fallback ok)');
  upd(cb('voice:0'));
  await waitFor(hasText('Job summary'), 'confirm card');
  const summary = sent.filter(s => (s.text || '').includes('Job summary')).pop().text;
  assert.ok(summary.includes('line') && summary.includes('9:16') && summary.includes('gpt-oss-120b'));

  upd(cb('confirm'));
  await waitFor(hasText('queue'), 'queued message');
  console.log('  ✓ flow: /start → mode → content → provider → live models → style → aspect → voice → confirm → queue');
  console.log('  ✓ owner-only lock verified (stranger ignored)');

  // (b) /help returns the explainer.
  upd(msg('/help'));
  await waitFor(hasText('How this bot works'), 'help text');
  const helpText = sent.filter(s => (s.text || '').includes('How this bot works')).pop().text;
  assert.ok(helpText.includes('Topic') && helpText.includes('Script') && helpText.includes('Voice'), 'help names the 3 modes');
  assert.ok(helpText.includes('buttons'), 'help says everything runs by buttons');
  assert.ok(helpText.includes('feedback'), 'help explains plain-text feedback');
  console.log('  ✓ /help returns the explainer');

  // (c) /cancel mid-setup clears the draft/step: start a script setup,
  // cancel at the content step, then plain text must NOT be taken as the
  // script (it would advance to the provider step) — it hits the fallback.
  const modesBefore = countText('What will you give');
  upd(msg('/start'));
  await waitFor(() => countText('What will you give') > modesBefore, 'mode keyboard again');
  upd(cb('mode:script'));
  await waitFor(hasText('Type the full script'), 'script content prompt');
  upd(msg('/cancel'));
  await waitFor(hasText('Setup cancelled'), 'cancel reply');
  upd(msg('this text must not become a script'));
  await waitFor(hasText('Press /start to begin a new video.'), 'fallback after cancel — old step is gone');
  assert.ok(!hasText('Which provider')() || countText('Which provider') === 1, 'cancelled setup did not advance to provider step');
  console.log('  ✓ /cancel mid-setup clears state (plain text no longer continues the old step)');

  // (d) /script jumps straight into script mode (no menu): the next text
  // is taken as the script and lands at the provider step, mode 'script'.
  const draftMode = () => JSON.parse(readFileSync(join(ROOT, 'data', 'state.json'), 'utf8'))['42'].draft.mode;
  const scriptPrompts = countText('Type the full script');
  const providersSeen = countText('Which provider');
  upd(msg('/script'));
  await waitFor(() => countText('Type the full script') > scriptPrompts, 'script prompt via /script');
  upd(msg('the quick brown fox narrates this video'));
  await waitFor(() => countText('Which provider') > providersSeen, 'provider step after /script text');
  assert.equal(draftMode(), 'script');
  console.log('  ✓ /script → text lands at provider step with draft mode script');

  // (e) /topic likewise — and it works from mid-setup (provider step of
  // the /script flow above), starting a fresh draft with mode 'topic'.
  const topicPrompts = countText('Type your topic');
  const providersSeen2 = countText('Which provider');
  upd(msg('/topic'));
  await waitFor(() => countText('Type your topic') > topicPrompts, 'topic prompt via /topic');
  upd(msg('why the moon changes shape'));
  await waitFor(() => countText('Which provider') > providersSeen2, 'provider step after /topic text');
  assert.equal(draftMode(), 'topic');
  console.log('  ✓ /topic → text lands at provider step with draft mode topic');

  // (f) /voice jumps into voice mode, and its prompt frames the input as
  // a voice SCRIPT — the owner's full recorded narration, video built
  // from his own audio — not a casual "voice note" to transcribe only.
  upd(msg('/voice'));
  await waitFor(hasText('Send your voice script'), 'voice prompt via /voice');
  const voicePrompt = sent.filter(s => (s.text || '').includes('Send your voice script')).pop().text;
  assert.ok(voicePrompt.includes('your audio stays as the narration'), 'voice prompt: his audio is the narration');
  assert.ok(voicePrompt.includes('No script writing, no TTS'), 'voice prompt: no script generation, no TTS');
  assert.equal(draftMode(), 'voice');
  console.log('  ✓ /voice → prompt asks for a voice script, draft mode voice');
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
