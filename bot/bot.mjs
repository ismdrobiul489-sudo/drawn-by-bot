// drawn-by-bot — Telegram front end.
// Conversation flow (button-driven, state in data/state.json):
//   /start → input mode → content → provider → model (live list) → style →
//   aspect → voice (TTS modes) → confirm → queued job.
// After a job's animatic arrives, free-text chat IS the feedback channel to
// the same OpenCode session — exactly how the user talks to Claude.
// While a job runs, the agent's permission requests and questions arrive
// here too, as text + buttons (bot/relay.mjs) — no typed yes/no, ever.
// All user-facing text is in English.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env, ROOT } from '../lib/env.mjs';
import { Telegram, keyboard, rowsOf } from './telegram.mjs';
import { listModels, PROVIDERS } from './models.mjs';
import { listStyles, styleLabel } from './styles.mjs';
import { listVoices } from '../media/tts.mjs';
import { JobQueue } from './queue.mjs';
import { processJob, sendFeedback, finalizeJob } from './processor.mjs';
import { agentServer } from './agent-server.mjs';
import { AskRelay } from './relay.mjs';
import { startStoreServer, rotateStore } from '../media/store.mjs';

const OWNER = Number(env('OWNER_TELEGRAM_ID', '0'));
const STATE_FILE = join(ROOT, 'data', 'state.json');

function loadState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState() { mkdirSync(join(ROOT, 'data'), { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
const state = loadState(); // chatId -> { step, draft, models, voices, activeJobId, statusMsgId }
function chatState(id) { if (!state[id]) state[id] = { step: 'idle', draft: {} }; return state[id]; }

const tg = new Telegram(env('TELEGRAM_BOT_TOKEN'));
const relay = new AskRelay({ tg, agent: agentServer });
const busyJobs = new Set(); // jobs in a feedback/final OpenCode run right now

const queue = new JobQueue(async job => {
  const cs = chatState(job.chatId);
  cs.activeJobId = job.id;
  saveState();
  const st = await tg.sendMessage(job.chatId, `🎬 ${job.id} is starting from the queue…`);
  cs.statusMsgId = st.message_id;
  saveState();
  const hooks = makeHooks(job);
  try {
    await processJob(job, hooks);
    queue.update(job, { sessionId: job.sessionId, stage: job.stage, jobDir: job.jobDir });
  } catch (e) {
    queue.update(job, { sessionId: job.sessionId, jobDir: job.jobDir });
    await tg.sendMessage(job.chatId, `❌ ${job.id} failed: ${e.message}\nPress /start to begin again.`).catch(() => {});
    const cs2 = chatState(job.chatId);
    if (cs2.activeJobId === job.id) { cs2.activeJobId = null; cs2.step = 'idle'; saveState(); }
    throw e; // queue records the failure in history
  }
});

function makeHooks(job) {
  const cs = chatState(job.chatId);
  return {
    relay,
    async status(text) {
      if (cs.statusMsgId) {
        try { await tg.editMessageText(job.chatId, cs.statusMsgId, text.slice(0, 3900)); return; } catch { /* fall through */ }
      }
      const m = await tg.sendMessage(job.chatId, text);
      cs.statusMsgId = m.message_id; saveState();
    },
    async sendAnimatic(j, render, sheet) {
      const kb = keyboard([[
        { text: '✅ Final render', data: `final:${j.id}` },
        { text: '🔁 New video', data: 'new' },
      ]]);
      const caption = `🎞️ Animatic ready — ${j.id}\nStyle: ${j.style} • ${j.aspect} • ${j.provider}/${j.model}${j.voiceQcSummary ? `\n${j.voiceQcSummary}` : ''}\n\nWatch it and reply in plain words — I will revise it and send it again. Happy with it? Press ✅ Final render.`;
      if (sheet) { try { await tg.sendPhoto(job.chatId, sheet, caption, kb); return; } catch { /* fall through */ } }
      try { await tg.sendVideo(job.chatId, render, caption); } catch { await tg.sendMessage(job.chatId, caption, kb); return; }
      await tg.sendMessage(job.chatId, 'How is it? Write your feedback, or:', kb);
    },
    async deliver(j, result) {
      const lines = [`✅ Video ready — ${j.id}`];
      if (j.voiceQcSummary) lines.push(j.voiceQcSummary);
      if (result.qc) lines.push(result.qc.pass === true ? '🔍 Vision QC: pass' : result.qc.pass === false ? `🔍 Vision QC issues: ${(result.qc.issues || []).join('; ')}` : `🔍 QC: ${(result.qc.issues || []).join('; ')}`);
      if (result.reencoded) lines.push('ℹ️ Sent with a reduced bitrate to fit Telegram; the full master is at the backup link.');
      if (result.storedUrl) lines.push(`💾 Backup (master): ${result.storedUrl}`);
      await tg.sendVideo(job.chatId, result.deliveryFile, lines.join('\n').slice(0, 1000));
      const srt = join(j.jobDir, 'captions.srt');
      if (existsSync(srt)) await tg.sendDocument(job.chatId, srt, 'captions.srt', 'Subtitles (SRT)');
      const script = ['script.txt', 'input.txt', 'transcript.txt'].map(f => join(j.jobDir, f)).find(existsSync);
      if (script) await tg.sendDocument(job.chatId, script, 'script.txt', 'Script / transcript');
      cs.activeJobId = null; cs.step = 'idle'; saveState();
    },
  };
}

// ── Flow steps ──────────────────────────────────────────────────────────────

async function stepMode(chatId) {
  const cs = chatState(chatId);
  cs.step = 'mode'; cs.draft = {}; saveState();
  await tg.sendMessage(chatId, 'What will you give? A Topic makes the script + voice for you; a Script makes the voice only; a Voice note is transcribed with Whisper into an SRT.', keyboard([[
    { text: '💡 Topic', data: 'mode:topic' },
    { text: '📝 Script', data: 'mode:script' },
    { text: '🎙️ Voice', data: 'mode:voice' },
  ]]));
}

async function stepProvider(chatId) {
  const cs = chatState(chatId);
  cs.step = 'provider'; saveState();
  // DEFAULT_PROVIDER from .env (any letter case) is shown first, starred.
  const def = (env('DEFAULT_PROVIDER', 'groq') || 'groq').trim().toLowerCase();
  const opts = [
    { text: '⚡ Groq', data: 'prov:groq', key: 'groq' },
    { text: '🟢 NVIDIA', data: 'prov:nvidia', key: 'nvidia' },
  ];
  opts.sort((a, b) => (a.key === def ? -1 : b.key === def ? 1 : 0));
  const row = opts.map(({ text, data, key }) => ({ text: key === def ? `${text} ⭐` : text, data }));
  await tg.sendMessage(chatId, 'Which provider should run this job?', keyboard([row]));
}

async function stepModel(chatId, { refresh = false, page = 0 } = {}) {
  const cs = chatState(chatId);
  const provider = cs.draft.provider;
  await tg.sendMessage(chatId, `⏳ Fetching the live model list from ${PROVIDERS[provider].label}…`);
  let models;
  try {
    ({ models } = await listModels(provider, { refresh }));
  } catch (e) {
    await tg.sendMessage(chatId, `❌ ${e.message}`, keyboard([[{ text: '🔄 Try again', data: 'models:refresh' }, { text: '⬅️ Change provider', data: 'back:provider' }]]));
    return;
  }
  cs.models = models; cs.step = 'model'; saveState();
  const per = 10;
  const pages = Math.max(1, Math.ceil(models.length / per));
  const slice = models.slice(page * per, page * per + per);
  const def = PROVIDERS[provider].defaultModel();
  const btns = slice.map((m, i) => ({ text: (m === def ? '⭐ ' : '') + m.split('/').pop(), data: `model:${page * per + i}` }));
  const rows = rowsOf(btns, 1);
  const nav = [];
  if (page > 0) nav.push({ text: '⬅️ Previous', data: `models:page:${page - 1}` });
  if (page < pages - 1) nav.push({ text: 'Next ➡️', data: `models:page:${page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: '🔄 Refresh list', data: 'models:refresh' }, { text: '⬅️ Provider', data: 'back:provider' }]);
  await tg.sendMessage(chatId, `Select a model (${PROVIDERS[provider].label} — ${models.length} chat models available):`, keyboard(rows));
}

async function stepStyle(chatId) {
  const cs = chatState(chatId);
  cs.step = 'style'; saveState();
  const styles = listStyles();
  if (!styles.length) { await tg.sendMessage(chatId, '❌ No styles found in core/styles/ — is core/ in place?'); return; }
  const btns = styles.map(s => ({ text: styleLabel(s), data: `style:${s.name}` }));
  await tg.sendMessage(chatId, '🎨 Select a style (✅ = approved, 🧪 = testing, ⚠️GPU = raymarch/WebGL — very slow on a CPU-only VPS):', keyboard(rowsOf(btns, 2)));
}

async function stepAspect(chatId) {
  const cs = chatState(chatId);
  cs.step = 'aspect'; saveState();
  await tg.sendMessage(chatId, '📐 Aspect ratio?', keyboard([[
    { text: '📱 9:16 (1080×1920)', data: 'aspect:9:16' },
    { text: '🖥️ 16:9 (1920×1080)', data: 'aspect:16:9' },
  ]]));
}

async function stepVoice(chatId, { page = 0 } = {}) {
  const cs = chatState(chatId);
  if (cs.draft.mode === 'voice') { await stepConfirm(chatId); return; } // user gave audio — no TTS
  const { voices, dynamic } = await listVoices();
  cs.voices = voices; cs.step = 'voice'; saveState();
  const per = 10;
  const pages = Math.max(1, Math.ceil(voices.length / per));
  const slice = voices.slice(page * per, page * per + per);
  const btns = slice.map((v, i) => ({ text: `${v.gender === 'Female' ? '👩' : '👨'} ${v.name} (${v.locale})`, data: `voice:${page * per + i}` }));
  const rows = rowsOf(btns, 1);
  const nav = [];
  if (page > 0) nav.push({ text: '⬅️ Previous', data: `voices:page:${page - 1}` });
  if (page < pages - 1) nav.push({ text: 'Next ➡️', data: `voices:page:${page + 1}` });
  if (nav.length) rows.push(nav);
  await tg.sendMessage(chatId, `🗣️ Which voice should narrate?${dynamic ? '' : ' (edge-tts CLI not found — fallback list; run setup.sh on the VPS for the full live list)'}`, keyboard(rows));
}

async function stepConfirm(chatId) {
  const cs = chatState(chatId);
  cs.step = 'confirm'; saveState();
  const d = cs.draft;
  const text = [
    '📋 Job summary:',
    `• Mode: ${d.mode}`,
    `• Input: ${d.mode === 'voice' ? '🎙️ audio file' : String(d.inputText || '').slice(0, 120)}`,
    `• Provider/Model: ${d.provider} / ${d.model}`,
    `• Style: ${d.style}   • Aspect: ${d.aspect}`,
    ...(d.mode !== 'voice' ? [`• Voice: ${d.voice}`] : []),
    '',
    'Shall I start?',
  ].join('\n');
  await tg.sendMessage(chatId, text, keyboard([[
    { text: '🚀 Start', data: 'confirm' },
    { text: '❌ Cancel', data: 'new' },
  ]]));
}

async function enqueue(chatId) {
  const cs = chatState(chatId);
  const d = cs.draft;
  const job = queue.enqueue({ chatId, ...d, finalNow: false });
  cs.activeJobId = job.id; cs.step = 'working'; cs.draft = {}; saveState();
  const pos = queue.position(job.id);
  await tg.sendMessage(chatId, pos >= 0
    ? `🧾 ${job.id} queued (${pos} job(s) ahead of it). Jobs run one at a time — I will tell you when yours starts.`
    : `🧾 ${job.id} created — starting…`);
}

// ── Update handling ─────────────────────────────────────────────────────────

async function onCallback(q) {
  const chatId = q.message.chat.id;
  if (q.from.id !== OWNER) { await tg.answerCallback(q.id, 'Owner only'); return; }
  const cs = chatState(chatId);
  const data = q.data || '';
  await tg.answerCallback(q.id);

  // Agent permission / question answers (bot/relay.mjs).
  if (data.startsWith('perm:') || data.startsWith('q:')) { await relay.handleCallback(chatId, data); return; }

  if (data === 'new') { cs.activeJobId = null; await stepMode(chatId); return; }
  if (data.startsWith('mode:')) {
    cs.draft.mode = data.slice(5); saveState();
    cs.step = 'content'; saveState();
    await tg.sendMessage(chatId, cs.draft.mode === 'voice'
      ? '🎙️ Send a voice note or an audio file.'
      : cs.draft.mode === 'topic' ? '💡 Type your topic and send it (one line is enough).' : '📝 Type the full script and send it.');
    return;
  }
  if (data === 'back:provider') { await stepProvider(chatId); return; }
  if (data.startsWith('prov:')) { cs.draft.provider = data.slice(5); saveState(); await stepModel(chatId); return; }
  if (data === 'models:refresh') { await stepModel(chatId, { refresh: true }); return; }
  if (data.startsWith('models:page:')) { await stepModel(chatId, { page: Number(data.split(':')[2]) || 0 }); return; }
  if (data.startsWith('model:')) {
    const m = (cs.models || [])[Number(data.slice(6))];
    if (!m) { await tg.sendMessage(chatId, '⚠️ The model list is stale — fetching it again.'); await stepModel(chatId, { refresh: true }); return; }
    cs.draft.model = m; saveState(); await stepStyle(chatId); return;
  }
  if (data.startsWith('style:')) {
    cs.draft.style = data.slice(6); saveState();
    const st = listStyles().find(s => s.name === cs.draft.style);
    if (st?.gpu) await tg.sendMessage(chatId, `⚠️ "${st.name}" is a raymarching/WebGL style — rendering will be very slow on a VPS without a GPU. It will still run.`);
    await stepAspect(chatId); return;
  }
  if (data.startsWith('aspect:')) { cs.draft.aspect = data.slice(7); saveState(); await stepVoice(chatId); return; }
  if (data.startsWith('voices:page:')) { await stepVoice(chatId, { page: Number(data.split(':')[2]) || 0 }); return; }
  if (data.startsWith('voice:')) {
    const v = (cs.voices || [])[Number(data.slice(6))];
    if (!v) { await tg.sendMessage(chatId, '⚠️ The voice list is stale — fetching it again.'); await stepVoice(chatId); return; }
    cs.draft.voice = v.shortName; saveState(); await stepConfirm(chatId); return;
  }
  if (data === 'confirm') { await enqueue(chatId); return; }
  if (data.startsWith('final:')) {
    const job = queue.get(data.slice(6));
    if (!job) { await tg.sendMessage(chatId, '⚠️ Job not found.'); return; }
    if (busyJobs.has(job.id)) { await tg.sendMessage(chatId, '⏳ This job is busy right now — please wait.'); return; }
    busyJobs.add(job.id);
    try { await finalizeJob(job, makeHooks(job)); queue.update(job, { stage: 'final' }); }
    catch (e) { await tg.sendMessage(chatId, `❌ Final render failed: ${e.message}`); }
    finally { busyJobs.delete(job.id); }
    return;
  }
}

async function onMessage(msg) {
  const chatId = msg.chat.id;
  if (msg.from.id !== OWNER) return; // owner-only lock: everyone else is ignored entirely
  const cs = chatState(chatId);
  const text = msg.text || '';

  if (text === '/start' || text === '/new') { cs.activeJobId = null; await stepMode(chatId); return; }

  if (cs.step === 'content') {
    if (cs.draft.mode === 'voice') {
      const att = msg.voice || msg.audio || (msg.document?.mime_type?.startsWith('audio') ? msg.document : null);
      if (!att) { await tg.sendMessage(chatId, '🎙️ Please send an audio / voice file.'); return; }
      mkdirSync(join(ROOT, 'data', 'uploads'), { recursive: true });
      const ext = msg.voice ? '.ogg' : (att.file_name ? `.${att.file_name.split('.').pop()}` : '.mp3');
      const dest = join(ROOT, 'data', 'uploads', `${chatId}-${Date.now()}${ext}`);
      await tg.download(att.file_id, dest);
      cs.draft.inputAudioPath = dest; cs.draft.inputAudioExt = ext; saveState();
      await stepProvider(chatId);
      return;
    }
    if (!text) { await tg.sendMessage(chatId, '✍️ Please type it and send.'); return; }
    cs.draft.inputText = text; saveState();
    await stepProvider(chatId);
    return;
  }

  // A free-text question from the agent is waiting — this message IS the
  // answer (permission requests never take free text, only buttons).
  if (text && relay.pendingTextFor(chatId)) {
    await relay.handleTextAnswer(chatId, text);
    return;
  }

  // Free text with an animatic-stage job = feedback to the same session.
  const job = cs.activeJobId ? queue.get(cs.activeJobId) : null;
  if (text && job && job.stage === 'awaiting-feedback' && job.sessionId) {
    if (busyJobs.has(job.id)) { await tg.sendMessage(chatId, '⏳ The previous feedback is still being applied…'); return; }
    busyJobs.add(job.id);
    try {
      await tg.sendMessage(chatId, '✏️ Feedback sent to the agent…');
      await sendFeedback(job, text, makeHooks(job));
      queue.update(job, { sessionId: job.sessionId });
    } catch (e) {
      await tg.sendMessage(chatId, `❌ Feedback run failed: ${e.message}`);
    } finally { busyJobs.delete(job.id); }
    return;
  }

  if (text) await tg.sendMessage(chatId, 'Press /start to begin a new video.');
}

// ── Boot ────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!OWNER) console.error('[bot] WARNING: OWNER_TELEGRAM_ID not set — the bot will ignore everyone.');
  startStoreServer();
  const removed = rotateStore();
  if (removed) console.log(`[store] rotated ${removed} old job(s)`);
  relay.start();
  await relay.resendPending(); // re-show any ask a restart interrupted
  console.log('[bot] polling… (owner-only)');
  await tg.poll(async u => {
    if (u.callback_query) await onCallback(u.callback_query);
    else if (u.message) await onMessage(u.message);
  });
}

export { onCallback, onMessage, queue, chatState, relay };
