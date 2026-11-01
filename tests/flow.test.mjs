// Flow test: run the real bot against a MOCK Telegram API (local server) and
// drive /start → mode → content → style → aspect → voice → confirm with
// canned updates. Provider/model are NEVER steps: jobs silently use the
// saved current selection (initialised from .env); /model is the only
// place it changes — the test drives that too, plus a following job.
// Groq/NVIDIA /models are mocked. The queued jobs will fail during
// processing (no real providers/opencode here) — that graceful failure
// is expected and cleaned up.
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
    if (url.endsWith('/models')) { // provider /models mocks
      if (url.includes('/nvidia')) {
        res.end(JSON.stringify({ data: [
          { id: 'nvidia/nemotron-3-super-120b-a12b' }, { id: 'z-ai/glm-5.3' },
          { id: 'deepseek-ai/deepseek-v4-flash' }, { id: 'nvidia/nvclip' },
        ] }));
      } else {
        res.end(JSON.stringify({ data: [
          { id: 'openai/gpt-oss-120b' }, { id: 'whisper-large-v3' },
          { id: 'canopylabs/orpheus-v1-english' }, { id: 'qwen/qwen3.8-27b' },
        ] }));
      }
      return;
    }
    if (url.endsWith('/chat/completions')) {
      // Model probes must ALL fail in this env: if any fallback candidate
      // answered, the processor's (correct) probe/dead-model machinery
      // would rewrite the job's provider/model after the OpenCode failure,
      // and the jobs.json assertions below check the ENQUEUE-time
      // selection. So jobs fail at the pre-flight probe instead — still a
      // graceful, expected failure. /models above stays live for /model.
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: 'model not provisioned (mock)' } }));
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
  NVIDIA_API_KEY: 'test-key',
  NVIDIA_BASE_URL: `http://127.0.0.1:${port}/nvidia`,
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
const jobsDb = () => { try { return JSON.parse(readFileSync(join(ROOT, 'data', 'jobs.json'), 'utf8')); } catch { return { queue: [], history: [], active: null }; } };
const allJobs = () => { const db = jobsDb(); return [...(db.active ? [db.active] : []), ...db.queue, ...db.history]; };

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
    { command: 'model', description: 'Change the current model' },
    { command: 'cancel', description: 'Cancel the current setup' },
    { command: 'help', description: 'How this bot works' },
  ]);
  console.log('  ✓ setMyCommands registered the 8-command menu at boot');

  // A stranger is ignored:
  pending.push({ update_id: ++updateId, message: { message_id: 1, chat: { id: 99 }, from: { id: 99 }, text: '/start' } });
  await sleep(600);
  assert.ok(!sent.some(s => s.chat_id === 99), 'stranger must be ignored');

  upd(cb('mode:topic'));
  await waitFor(hasText('Type your topic'), 'topic prompt');
  upd(msg('test topic about rain'));
  // NO provider/model steps any more: content goes straight to style.
  await waitFor(hasText('Select a style'), 'style list right after content');
  assert.ok(!hasText('Which provider')(), 'no provider prompt in the job flow');
  assert.ok(!hasText('Select a model')(), 'no model prompt in the job flow');
  assert.ok(JSON.stringify(lastKb('Select a style')).includes('style:line'));

  upd(cb('style:line'));
  await waitFor(hasText('Aspect ratio'), 'aspect');
  upd(cb('aspect:9:16'));
  await waitFor(hasText('Which voice'), 'voice list (fallback ok)');
  upd(cb('voice:0'));
  await waitFor(hasText('Job summary'), 'confirm card');
  const summary = sent.filter(s => (s.text || '').includes('Job summary')).pop().text;
  assert.ok(summary.includes('line') && summary.includes('9:16'));
  assert.ok(summary.includes('🤖 groq / openai/gpt-oss-120b'), 'confirm shows the .env-default current model as a plain info line');
  assert.ok(summary.includes('/model'), 'confirm info line names /model as the only place to change it');

  upd(cb('confirm'));
  await waitFor(hasText('queue'), 'queued message');
  const j1 = allJobs().find(j => (j.inputText || '').includes('rain'));
  assert.ok(j1, 'job-1 persisted to jobs.json');
  assert.equal(j1.provider, 'groq', 'job-1 carries the .env-default provider');
  assert.equal(j1.model, 'openai/gpt-oss-120b', 'job-1 carries the .env-default model');
  console.log('  ✓ flow: /start → mode → content → style → aspect → voice → confirm → queue (no provider/model steps)');
  console.log('  ✓ job carries the .env-default selection; confirm shows it as an info line');
  console.log('  ✓ owner-only lock verified (stranger ignored)');

  // (b) /help returns the explainer.
  upd(msg('/help'));
  await waitFor(hasText('How this bot works'), 'help text');
  const helpText = sent.filter(s => (s.text || '').includes('How this bot works')).pop().text;
  assert.ok(helpText.includes('Topic') && helpText.includes('Script') && helpText.includes('Voice'), 'help names the 3 modes');
  assert.ok(helpText.includes('buttons'), 'help says everything runs by buttons');
  assert.ok(helpText.includes('feedback'), 'help explains plain-text feedback');
  assert.ok(helpText.includes('/model'), 'help mentions /model factually');
  assert.ok(!helpText.includes('per job'), 'help no longer describes per-job model picking');
  console.log('  ✓ /help returns the explainer');

  // (c) /cancel mid-setup clears the draft/step: start a script setup,
  // cancel at the content step, then plain text must NOT be taken as the
  // script (it would advance to the style step) — it hits the fallback.
  const modesBefore = countText('What will you give');
  upd(msg('/start'));
  await waitFor(() => countText('What will you give') > modesBefore, 'mode keyboard again');
  upd(cb('mode:script'));
  await waitFor(hasText('Type the full script'), 'script content prompt');
  upd(msg('/cancel'));
  await waitFor(hasText('Setup cancelled'), 'cancel reply');
  upd(msg('this text must not become a script'));
  await waitFor(hasText('Press /start to begin a new video.'), 'fallback after cancel — old step is gone');
  assert.equal(countText('Select a style'), 1, 'cancelled setup did not advance to the style step');
  console.log('  ✓ /cancel mid-setup clears state (plain text no longer continues the old step)');

  // (d) /script jumps straight into script mode (no menu): the next text
  // is taken as the script and lands at the style step, mode 'script'.
  const draftMode = () => JSON.parse(readFileSync(join(ROOT, 'data', 'state.json'), 'utf8'))['42'].draft.mode;
  const scriptPrompts = countText('Type the full script');
  const stylesSeen = countText('Select a style');
  upd(msg('/script'));
  await waitFor(() => countText('Type the full script') > scriptPrompts, 'script prompt via /script');
  upd(msg('the quick brown fox narrates this video'));
  await waitFor(() => countText('Select a style') > stylesSeen, 'style step right after /script text');
  assert.equal(draftMode(), 'script');
  console.log('  ✓ /script → text lands at style step with draft mode script');

  // (e) /topic likewise — and it works from mid-setup (style step of
  // the /script flow above), starting a fresh draft with mode 'topic'.
  const topicPrompts = countText('Type your topic');
  const stylesSeen2 = countText('Select a style');
  upd(msg('/topic'));
  await waitFor(() => countText('Type your topic') > topicPrompts, 'topic prompt via /topic');
  upd(msg('why the moon changes shape'));
  await waitFor(() => countText('Select a style') > stylesSeen2, 'style step right after /topic text');
  assert.equal(draftMode(), 'topic');
  console.log('  ✓ /topic → text lands at style step with draft mode topic');

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

  // (g) /model — the ONLY place the selection changes. It opens from the
  // owner's own command, shows the current (.env-default) selection,
  // switches provider, picks a model from the mocked live list, and the
  // FOLLOWING job then uses the new selection.
  const selOf = () => JSON.parse(readFileSync(join(ROOT, 'data', 'state.json'), 'utf8'))['42'].selection;
  upd(msg('/model'));
  await waitFor(hasText('Current model:'), '/model shows the current selection');
  const pickerMsg = sent.filter(s => (s.text || '').includes('Current model:')).pop();
  assert.ok(pickerMsg.text.includes('groq / openai/gpt-oss-120b'), 'picker shows the .env-default selection');
  assert.ok(JSON.stringify(pickerMsg.reply_markup).includes('mprov:nvidia'), 'picker offers the other provider');

  // The current provider's list stars the current model.
  upd(cb('mprov:groq'));
  await waitFor(hasText('Select a model'), 'live Groq model list inside /model');
  const groqKb = JSON.stringify(lastKb('Select a model'));
  assert.ok(groqKb.includes('gpt-oss-120b') && groqKb.includes('⭐'), 'current model starred in its provider list');
  assert.ok(!groqKb.includes('whisper'), 'whisper filtered out of chat models');

  upd(cb('mpick'));
  await waitFor(() => countText('Current model:') >= 2, 'back at the provider picker');
  upd(cb('mprov:nvidia'));
  await waitFor(() => countText('Select a model') >= 2, 'live NVIDIA model list inside /model');
  const nvidiaKb = JSON.stringify(lastKb('Select a model'));
  assert.ok(nvidiaKb.includes('nemotron-3-super-120b-a12b'), 'NVIDIA model listed');
  assert.ok(!nvidiaKb.includes('nvclip'), 'non-chat NVIDIA model filtered out');
  // Sorted list: deepseek(0), nemotron(1), glm(2) — pick glm, NOT the default.
  upd(cb('mmodel:2'));
  await waitFor(hasText('Current model set to nvidia / z-ai/glm-5.3'), 'switch confirmation text');
  assert.deepEqual(selOf(), { provider: 'nvidia', model: 'z-ai/glm-5.3' }, 'selection persisted in state.json');
  console.log('  ✓ /model: shows current, switches provider + model from the live list, persists the selection');

  // A job started now uses the new selection — on the confirm card and
  // in the persisted job.
  upd(msg('/topic'));
  await waitFor(hasText('Type your topic'), 'topic prompt (post-switch job)');
  upd(msg('a lighthouse in a storm'));
  await waitFor(hasText('Select a style'), 'style step (post-switch job)');
  upd(cb('style:line'));
  await waitFor(hasText('Aspect ratio'), 'aspect (post-switch job)');
  upd(cb('aspect:16:9'));
  await waitFor(hasText('Which voice'), 'voice list (post-switch job)');
  upd(cb('voice:0'));
  await waitFor(() => countText('Job summary') >= 2, 'confirm card (post-switch job)');
  const summary2 = sent.filter(s => (s.text || '').includes('Job summary')).pop().text;
  assert.ok(summary2.includes('🤖 nvidia / z-ai/glm-5.3'), 'confirm shows the switched current model');
  upd(cb('confirm'));
  await waitFor(() => allJobs().some(j => (j.inputText || '').includes('lighthouse')), 'post-switch job persisted');
  const j2 = allJobs().find(j => (j.inputText || '').includes('lighthouse'));
  assert.equal(j2.provider, 'nvidia', 'post-switch job carries the new provider');
  assert.equal(j2.model, 'z-ai/glm-5.3', 'post-switch job carries the new model');
  console.log('  ✓ a job started after /model uses the new selection (confirm line + persisted job)');
} finally {
  bot.kill('SIGKILL');
  server.close();
  // Clean the sandbox job folder the (expected-to-fail) test job created.
  const sandbox = join(ROOT, 'core', 'sandbox');
  if (existsSync(sandbox)) {
    for (const d of readdirSync(sandbox)) {
      if (d.includes('test-topic-about-rain') || d.includes('lighthouse-in-a-storm')) rmSync(join(sandbox, d), { recursive: true, force: true });
    }
  }
  rmSync(join(ROOT, 'data'), { recursive: true, force: true });
}
