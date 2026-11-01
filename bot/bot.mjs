// drawn-by-bot — Telegram front end.
// Conversation flow (button-driven, state in data/state.json):
//   /start → input mode → content → provider → model (live list) → style →
//   aspect → voice (TTS modes) → confirm → queued job.
// After a job's animatic arrives, free-text chat IS the feedback channel to
// the same OpenCode session — exactly how the user talks to Claude.
// Bengali-first messages; English for technical terms.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env, ROOT } from '../lib/env.mjs';
import { Telegram, keyboard, rowsOf } from './telegram.mjs';
import { listModels, PROVIDERS } from './models.mjs';
import { listStyles, styleLabel } from './styles.mjs';
import { listVoices } from '../media/tts.mjs';
import { JobQueue } from './queue.mjs';
import { processJob, sendFeedback, finalizeJob } from './processor.mjs';
import { startStoreServer, rotateStore } from '../media/store.mjs';

const OWNER = Number(env('OWNER_TELEGRAM_ID', '0'));
const STATE_FILE = join(ROOT, 'data', 'state.json');

function loadState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState() { mkdirSync(join(ROOT, 'data'), { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
const state = loadState(); // chatId -> { step, draft, models, voices, activeJobId, statusMsgId }
function chatState(id) { if (!state[id]) state[id] = { step: 'idle', draft: {} }; return state[id]; }

const tg = new Telegram(env('TELEGRAM_BOT_TOKEN'));
const busyJobs = new Set(); // jobs in a feedback/final OpenCode run right now

const queue = new JobQueue(async job => {
  const cs = chatState(job.chatId);
  cs.activeJobId = job.id;
  saveState();
  const st = await tg.sendMessage(job.chatId, `🎬 ${job.id} queue থেকে শুরু হলো…`);
  cs.statusMsgId = st.message_id;
  saveState();
  const hooks = makeHooks(job);
  try {
    await processJob(job, hooks);
    queue.update(job, { sessionId: job.sessionId, stage: job.stage, jobDir: job.jobDir });
  } catch (e) {
    queue.update(job, { sessionId: job.sessionId, jobDir: job.jobDir });
    await tg.sendMessage(job.chatId, `❌ ${job.id} ব্যর্থ হলো: ${e.message}\nনতুন করে শুরু করতে /start চাপুন।`).catch(() => {});
    const cs2 = chatState(job.chatId);
    if (cs2.activeJobId === job.id) { cs2.activeJobId = null; cs2.step = 'idle'; saveState(); }
    throw e; // queue records the failure in history
  }
});

function makeHooks(job) {
  const cs = chatState(job.chatId);
  return {
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
      const caption = `🎞️ Animatic তৈরি — ${j.id}\nStyle: ${j.style} • ${j.aspect} • ${j.provider}/${j.model}\n\nদেখে মতামত লিখুন (সাধারণ ভাষায়) — আমি বদলে আবার পাঠাব। ঠিক থাকলে Final render চাপুন।`;
      if (sheet) { try { await tg.sendPhoto(job.chatId, sheet, caption, kb); return; } catch { /* fall through */ } }
      try { await tg.sendVideo(job.chatId, render, caption); } catch { await tg.sendMessage(job.chatId, caption, kb); return; }
      await tg.sendMessage(job.chatId, 'কেমন হলো? মতামত লিখুন, অথবা:', kb);
    },
    async deliver(j, result) {
      const lines = [`✅ ভিডিও তৈরি — ${j.id}`];
      if (result.qc) lines.push(result.qc.pass === true ? '🔍 Vision QC: pass' : result.qc.pass === false ? `🔍 Vision QC issues: ${(result.qc.issues || []).join('; ')}` : `🔍 QC: ${(result.qc.issues || []).join('; ')}`);
      if (result.reencoded) lines.push('ℹ️ Telegram-এর জন্য bitrate কমিয়ে পাঠানো হলো; master নিচের link-এ।');
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
  await tg.sendMessage(chatId, 'কী দেবেন? Topic দিলে script + voice দুটোই তৈরি হবে; Script দিলে শুধু voice; Voice দিলে Whisper দিয়ে SRT তৈরি হবে।', keyboard([[
    { text: '💡 Topic', data: 'mode:topic' },
    { text: '📝 Script', data: 'mode:script' },
    { text: '🎙️ Voice', data: 'mode:voice' },
  ]]));
}

async function stepProvider(chatId) {
  const cs = chatState(chatId);
  cs.step = 'provider'; saveState();
  await tg.sendMessage(chatId, 'কোন provider চলবে এই job-এ?', keyboard([[
    { text: '⚡ Groq', data: 'prov:groq' },
    { text: '🟢 NVIDIA', data: 'prov:nvidia' },
  ]]));
}

async function stepModel(chatId, { refresh = false, page = 0 } = {}) {
  const cs = chatState(chatId);
  const provider = cs.draft.provider;
  await tg.sendMessage(chatId, `⏳ ${PROVIDERS[provider].label} থেকে live model list আনছি…`);
  let models;
  try {
    ({ models } = await listModels(provider, { refresh }));
  } catch (e) {
    await tg.sendMessage(chatId, `❌ ${e.message}`, keyboard([[{ text: '🔄 আবার চেষ্টা', data: 'models:refresh' }, { text: '⬅️ Provider বদলান', data: 'back:provider' }]]));
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
  if (page > 0) nav.push({ text: '⬅️ আগের', data: `models:page:${page - 1}` });
  if (page < pages - 1) nav.push({ text: 'পরের ➡️', data: `models:page:${page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: '🔄 List refresh', data: 'models:refresh' }, { text: '⬅️ Provider', data: 'back:provider' }]);
  await tg.sendMessage(chatId, `Model সিলেক্ট করুন (${PROVIDERS[provider].label}, মোট ${models.length}টা chat model পাওয়া গেছে):`, keyboard(rows));
}

async function stepStyle(chatId) {
  const cs = chatState(chatId);
  cs.step = 'style'; saveState();
  const styles = listStyles();
  if (!styles.length) { await tg.sendMessage(chatId, '❌ core/styles/ এ কোনো style পাওয়া যায়নি — core/ ঠিকমতো আছে তো?'); return; }
  const btns = styles.map(s => ({ text: styleLabel(s), data: `style:${s.name}` }));
  await tg.sendMessage(chatId, '🎨 Style সিলেক্ট করুন (✅ = approved, 🧪 = testing, ⚠️GPU = raymarch/WebGL — CPU VPS-এ খুব ধীর হবে):', keyboard(rowsOf(btns, 2)));
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
  if (page > 0) nav.push({ text: '⬅️ আগের', data: `voices:page:${page - 1}` });
  if (page < pages - 1) nav.push({ text: 'পরের ➡️', data: `voices:page:${page + 1}` });
  if (nav.length) rows.push(nav);
  await tg.sendMessage(chatId, `🗣️ কোন কণ্ঠে voice তৈরি হবে?${dynamic ? '' : ' (edge-tts CLI পাওয়া যায়নি — fallback list; VPS-এ setup.sh চালালে full live list আসবে)'}`, keyboard(rows));
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
    'শুরু করব?',
  ].join('\n');
  await tg.sendMessage(chatId, text, keyboard([[
    { text: '🚀 শুরু করুন', data: 'confirm' },
    { text: '❌ বাতিল', data: 'new' },
  ]]));
}

async function enqueue(chatId) {
  const cs = chatState(chatId);
  const d = cs.draft;
  const job = queue.enqueue({ chatId, ...d, finalNow: false });
  cs.activeJobId = job.id; cs.step = 'working'; cs.draft = {}; saveState();
  const pos = queue.position(job.id);
  await tg.sendMessage(chatId, pos >= 0
    ? `🧾 ${job.id} queue-তে গেল (সামনে ${pos}টা job)। একটা করে job চলে — আপনারটা শুরু হলে জানাব।`
    : `🧾 ${job.id} তৈরি — শুরু হচ্ছে…`);
}

// ── Update handling ─────────────────────────────────────────────────────────

async function onCallback(q) {
  const chatId = q.message.chat.id;
  if (q.from.id !== OWNER) { await tg.answerCallback(q.id, 'Owner only'); return; }
  const cs = chatState(chatId);
  const data = q.data || '';
  await tg.answerCallback(q.id);

  if (data === 'new') { cs.activeJobId = null; await stepMode(chatId); return; }
  if (data.startsWith('mode:')) {
    cs.draft.mode = data.slice(5); saveState();
    cs.step = 'content'; saveState();
    await tg.sendMessage(chatId, cs.draft.mode === 'voice'
      ? '🎙️ Voice note বা audio file পাঠান।'
      : cs.draft.mode === 'topic' ? '💡 Topic লিখে পাঠান (এক লাইনই যথেষ্ট)।' : '📝 পুরো script লিখে পাঠান।');
    return;
  }
  if (data === 'back:provider') { await stepProvider(chatId); return; }
  if (data.startsWith('prov:')) { cs.draft.provider = data.slice(5); saveState(); await stepModel(chatId); return; }
  if (data === 'models:refresh') { await stepModel(chatId, { refresh: true }); return; }
  if (data.startsWith('models:page:')) { await stepModel(chatId, { page: Number(data.split(':')[2]) || 0 }); return; }
  if (data.startsWith('model:')) {
    const m = (cs.models || [])[Number(data.slice(6))];
    if (!m) { await tg.sendMessage(chatId, '⚠️ Model list পুরনো হয়ে গেছে — আবার আনছি।'); await stepModel(chatId, { refresh: true }); return; }
    cs.draft.model = m; saveState(); await stepStyle(chatId); return;
  }
  if (data.startsWith('style:')) {
    cs.draft.style = data.slice(6); saveState();
    const st = listStyles().find(s => s.name === cs.draft.style);
    if (st?.gpu) await tg.sendMessage(chatId, `⚠️ "${st.name}" raymarching/WebGL style — GPU ছাড়া VPS-এ render খুব ধীর হবে। তবুও চলবে।`);
    await stepAspect(chatId); return;
  }
  if (data.startsWith('aspect:')) { cs.draft.aspect = data.slice(7); saveState(); await stepVoice(chatId); return; }
  if (data.startsWith('voices:page:')) { await stepVoice(chatId, { page: Number(data.split(':')[2]) || 0 }); return; }
  if (data.startsWith('voice:')) {
    const v = (cs.voices || [])[Number(data.slice(6))];
    if (!v) { await tg.sendMessage(chatId, '⚠️ Voice list পুরনো — আবার আনছি।'); await stepVoice(chatId); return; }
    cs.draft.voice = v.shortName; saveState(); await stepConfirm(chatId); return;
  }
  if (data === 'confirm') { await enqueue(chatId); return; }
  if (data.startsWith('final:')) {
    const job = queue.get(data.slice(6));
    if (!job) { await tg.sendMessage(chatId, '⚠️ Job পাওয়া যায়নি।'); return; }
    if (busyJobs.has(job.id)) { await tg.sendMessage(chatId, '⏳ এই job-এর কাজ চলছে, একটু অপেক্ষা করুন।'); return; }
    busyJobs.add(job.id);
    try { await finalizeJob(job, makeHooks(job)); queue.update(job, { stage: 'final' }); }
    catch (e) { await tg.sendMessage(chatId, `❌ Final render ব্যর্থ: ${e.message}`); }
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
      if (!att) { await tg.sendMessage(chatId, '🎙️ Audio/voice file পাঠান।'); return; }
      mkdirSync(join(ROOT, 'data', 'uploads'), { recursive: true });
      const ext = msg.voice ? '.ogg' : (att.file_name ? `.${att.file_name.split('.').pop()}` : '.mp3');
      const dest = join(ROOT, 'data', 'uploads', `${chatId}-${Date.now()}${ext}`);
      await tg.download(att.file_id, dest);
      cs.draft.inputAudioPath = dest; cs.draft.inputAudioExt = ext; saveState();
      await stepProvider(chatId);
      return;
    }
    if (!text) { await tg.sendMessage(chatId, '✍️ লিখে পাঠান।'); return; }
    cs.draft.inputText = text; saveState();
    await stepProvider(chatId);
    return;
  }

  // Free text with an animatic-stage job = feedback to the same session.
  const job = cs.activeJobId ? queue.get(cs.activeJobId) : null;
  if (text && job && job.stage === 'awaiting-feedback' && job.sessionId) {
    if (busyJobs.has(job.id)) { await tg.sendMessage(chatId, '⏳ আগের feedback-এর কাজ চলছে…'); return; }
    busyJobs.add(job.id);
    try {
      await tg.sendMessage(chatId, '✏️ Feedback পাঠানো হলো agent-এর কাছে…');
      await sendFeedback(job, text, makeHooks(job));
      queue.update(job, { sessionId: job.sessionId });
    } catch (e) {
      await tg.sendMessage(chatId, `❌ Feedback run ব্যর্থ: ${e.message}`);
    } finally { busyJobs.delete(job.id); }
    return;
  }

  if (text) await tg.sendMessage(chatId, 'নতুন ভিডিও শুরু করতে /start চাপুন।');
}

// ── Boot ────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!OWNER) console.error('[bot] WARNING: OWNER_TELEGRAM_ID not set — the bot will ignore everyone.');
  startStoreServer();
  const removed = rotateStore();
  if (removed) console.log(`[store] rotated ${removed} old job(s)`);
  console.log('[bot] polling… (owner-only)');
  await tg.poll(async u => {
    if (u.callback_query) await onCallback(u.callback_query);
    else if (u.message) await onMessage(u.message);
  });
}

export { onCallback, onMessage, queue, chatState };
