// drawn-by-bot — Telegram front end (CONVERSATIONAL model).
//
// There is no form and no job queue. The owner talks to ONE persistent
// OpenCode session exactly like a chat with Claude: plain text is a turn,
// the agent's replies come back as chat messages, its questions and
// permission requests arrive as buttons (bot/relay.mjs), and files it
// wants to deliver land via the send_file tool → data/outbox/ watcher
// (bot/outbox.mjs). The session lives at the repo root and persists in
// data/state.json across bot restarts.
//
// The only rigid parts left are commands:
//   /start  wake + status        /new    fresh conversation
//   /model  switch the standing model (the ONLY way it changes)
//   /cancel stop the running turn (or clear queued messages)
//   /help   how this works
// Provider/model are never asked anywhere else: every turn uses the
// chat's saved standing selection, initialised from .env.
//
// All bot-facing text is in English; the AGENT's own replies follow the
// owner's language (that is its instruction, not bot text).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { env, ROOT } from '../lib/env.mjs';
import { Telegram, keyboard, rowsOf } from './telegram.mjs';
import { listModels, PROVIDERS } from './models.mjs';
import { agentServer } from './agent-server.mjs';
import { AskRelay } from './relay.mjs';
import { Conversation, ensureMemoryFiles } from './conversation.mjs';
import { Outbox } from './outbox.mjs';
import { transcribeToSrt } from '../media/whisper.mjs';
import { startStoreServer, rotateStore } from '../media/store.mjs';

const OWNER = Number(env('OWNER_TELEGRAM_ID', '0'));
const STATE_FILE = join(ROOT, 'data', 'state.json');
const INBOX = join(ROOT, 'data', 'inbox');

function loadState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState() { mkdirSync(join(ROOT, 'data'), { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
const state = loadState();
// Migration: old-shape state files (job-form era) are tolerated — the
// selection is kept when present; obsolete fields (draft, activeJobId,
// statusMsgId…) are simply ignored, and any stale non-picker step is
// reset so it can never trap a message.
for (const cs of Object.values(state)) {
  if (cs && typeof cs === 'object' && cs.step && !['pick-provider', 'pick-model'].includes(cs.step)) cs.step = 'idle';
}
function chatState(id) { if (!state[id]) state[id] = { step: 'idle' }; return state[id]; }

// ── Standing provider/model selection ─────────────────────────────────────
// The .env defaults ARE the standing selection: used silently by every
// turn, never asked about. It changes only via the owner's /model
// command (or an automatic guard switch, which is announced) and then
// persists here until changed again.
function envDefaultSelection() {
  const p = (env('DEFAULT_PROVIDER', 'groq') || 'groq').trim().toLowerCase();
  const provider = PROVIDERS[p] ? p : 'groq';
  return { provider, model: PROVIDERS[provider].defaultModel() };
}
function selectionOf(cs) {
  const s = cs.selection;
  if (!s || !PROVIDERS[s.provider] || !s.model) { cs.selection = envDefaultSelection(); }
  return cs.selection;
}
function setSelection(cs, sel) { cs.selection = { provider: sel.provider, model: sel.model }; saveState(); }

const tg = new Telegram(env('TELEGRAM_BOT_TOKEN'));
const relay = new AskRelay({ tg, agent: agentServer });
const outbox = new Outbox({ tg, chatId: OWNER });
const conversation = new Conversation({
  tg, agent: agentServer, relay, outbox,
  chatState, saveState, selectionOf, setSelection,
  sessionDirectory: ROOT,
});
// Session lifecycle: a send_file delivery marked final=true ends the
// current session (one session per job); the next owner message starts
// a fresh one, briefed from data/memory/.
outbox.onFinalDelivery = () => { conversation.completeCurrentSession(OWNER); };

// ── /model — the ONLY place the standing selection changes ────────────────
// Entered exclusively via the owner's /model command; nothing else routes
// here. Shows the current selection, provider buttons (current first +
// ⭐), then that provider's LIVE model list. Tapping a model SAVES it as
// the standing selection; it applies from the next turn.
async function stepModelPicker(chatId) {
  const cs = chatState(chatId);
  cs.step = 'pick-provider'; saveState();
  const sel = selectionOf(cs);
  const opts = [
    { text: '⚡ Groq', data: 'mprov:groq', key: 'groq' },
    { text: '🟢 NVIDIA', data: 'mprov:nvidia', key: 'nvidia' },
  ];
  opts.sort((a, b) => (a.key === sel.provider ? -1 : b.key === sel.provider ? 1 : 0));
  const row = opts.map(({ text, data, key }) => ({ text: key === sel.provider ? `${text} ⭐` : text, data }));
  await tg.sendMessage(chatId, `🤖 Current model: ${sel.provider} / ${sel.model}\n\nPick a provider to see its models — tapping a model makes it the current one for all following turns.`, keyboard([row]));
}

async function stepModelList(chatId, { refresh = false, page = 0 } = {}) {
  const cs = chatState(chatId);
  const provider = cs.pickProvider;
  const sel = selectionOf(cs);
  await tg.sendMessage(chatId, `⏳ Fetching the live model list from ${PROVIDERS[provider].label}…`);
  let models;
  try {
    ({ models } = await listModels(provider, { refresh }));
  } catch (e) {
    await tg.sendMessage(chatId, `❌ ${e.message}`, keyboard([[{ text: '🔄 Try again', data: 'mmodels:refresh' }, { text: '⬅️ Change provider', data: 'mpick' }]]));
    return;
  }
  cs.models = models; cs.step = 'pick-model'; saveState();
  const per = 10;
  const pages = Math.max(1, Math.ceil(models.length / per));
  const slice = models.slice(page * per, page * per + per);
  const btns = slice.map((m, i) => ({ text: (provider === sel.provider && m === sel.model ? '⭐ ' : '') + m.split('/').pop(), data: `mmodel:${page * per + i}` }));
  const rows = rowsOf(btns, 1);
  const nav = [];
  if (page > 0) nav.push({ text: '⬅️ Previous', data: `mmodels:page:${page - 1}` });
  if (page < pages - 1) nav.push({ text: 'Next ➡️', data: `mmodels:page:${page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: '🔄 Refresh list', data: 'mmodels:refresh' }, { text: '⬅️ Provider', data: 'mpick' }]);
  await tg.sendMessage(chatId, `Select a model (${PROVIDERS[provider].label} — ${models.length} chat models available). It becomes the current model for all following turns:`, keyboard(rows));
}

// ── Attachments → conversation turns ──────────────────────────────────────

const safeName = s => String(s || 'file').replace(/[^\w.\-]+/g, '_').slice(-80);

/** Download a Telegram file into data/inbox/; returns its repo-relative path. */
async function saveToInbox(fileId, name) {
  mkdirSync(INBOX, { recursive: true });
  const dest = join(INBOX, name);
  await tg.download(fileId, dest);
  return `data/inbox/${name}`;
}

/** Transcribe an inbox audio file with Whisper; returns the text or null. */
async function transcribeInboxAudio(absPath) {
  const scratch = join(INBOX, `.whisper-${Date.now()}`);
  const r = await transcribeToSrt(absPath, scratch);
  return readFileSync(r.transcriptPath, 'utf8').trim() || null;
}

async function handleVoice(chatId, att, caption) {
  const ext = att.file_name ? `.${att.file_name.split('.').pop()}` : '.ogg';
  const name = `${Date.now()}-voice${ext}`;
  const rel = await saveToInbox(att.file_id, name);
  const abs = join(ROOT, rel);
  let transcript = null;
  try { transcript = await transcribeInboxAudio(abs); } catch (e) { console.error('[bot] inbox transcription failed:', e.message); }
  const lines = [];
  if (transcript) lines.push(`[Voice message, transcript:] ${transcript}`);
  else lines.push('[Voice message — the bot could not transcribe it; the audio file is below, transcribe it with the whisper tool if you need the words.]');
  lines.push(`[Audio file: ${rel} — if this is a voice script for a video, use this file as the narration track.]`);
  if (caption) lines.push(`[Owner's caption:] ${caption}`);
  await conversation.submit(chatId, lines.join('\n'));
}

async function handlePhoto(chatId, photo, caption) {
  const largest = photo[photo.length - 1];
  const name = `${Date.now()}-photo.jpg`;
  const rel = await saveToInbox(largest.file_id, name);
  const lines = [`[Photo received: ${rel} — you can inspect it with your vision tools if it matters.]`];
  if (caption) lines.push(`[Owner's caption:] ${caption}`);
  else lines.push('[The owner sent this photo without a caption — ask what he wants done with it if it is not obvious.]');
  await conversation.submit(chatId, lines.join('\n'));
}

async function handleDocument(chatId, doc, caption) {
  const name = `${Date.now()}-${safeName(doc.file_name || 'file')}`;
  const rel = await saveToInbox(doc.file_id, name);
  const lines = [`[File received: ${rel} (original name: ${doc.file_name || 'file'})]`];
  if (caption) lines.push(`[Owner's caption:] ${caption}`);
  await conversation.submit(chatId, lines.join('\n'));
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

  // /model picker callbacks — only reachable inside a /model session the
  // owner started himself with the /model command.
  if (data === 'mpick') { await stepModelPicker(chatId); return; }
  if (data.startsWith('mprov:')) { cs.pickProvider = data.slice(6); saveState(); await stepModelList(chatId); return; }
  if (data === 'mmodels:refresh') { await stepModelList(chatId, { refresh: true }); return; }
  if (data.startsWith('mmodels:page:')) { await stepModelList(chatId, { page: Number(data.split(':')[2]) || 0 }); return; }
  if (data.startsWith('mmodel:')) {
    const m = (cs.models || [])[Number(data.slice(7))];
    if (!m) { await tg.sendMessage(chatId, '⚠️ The model list is stale — fetching it again.'); await stepModelList(chatId, { refresh: true }); return; }
    setSelection(cs, { provider: cs.pickProvider, model: m });
    cs.step = 'idle'; saveState();
    await tg.sendMessage(chatId, `✅ Current model set to ${cs.pickProvider} / ${m} — all following turns will use it until you change it with /model.`);
    return;
  }
}

async function onMessage(msg) {
  const chatId = msg.chat.id;
  if (msg.from.id !== OWNER) return; // owner-only lock: everyone else is ignored entirely
  const cs = chatState(chatId);
  const text = msg.text || '';
  const caption = msg.caption || '';

  if (text === '/start') {
    cs.step = 'idle'; saveState();
    const sel = selectionOf(cs);
    await tg.sendMessage(chatId, [
      "👋 I'm awake — this is a conversation, not a form. Just talk to me.",
      `🤖 Current model: ${sel.provider} / ${sel.model} (change with /model)`,
      `💬 Conversation: ${cs.sessionId ? 'open — we can pick up right where we left off' : 'not started yet — your first message opens one'}`,
      '',
      "Send a topic, a full script, or a voice message with your recorded narration, and I'll make the video here in this chat. If something is unclear I'll ask — answers come as buttons.",
    ].join('\n'));
    return;
  }

  if (text === '/new') {
    await conversation.newConversation(chatId);
    cs.step = 'idle'; saveState();
    await tg.sendMessage(chatId, '🆕 Fresh conversation started — the old one is archived. Just tell me what to make next.');
    return;
  }

  // /model — the ONLY way the standing provider/model selection changes,
  // and only when the owner explicitly runs it. Nothing else routes here.
  if (text === '/model') { await stepModelPicker(chatId); return; }

  if (text === '/cancel') {
    cs.step = 'idle'; saveState();
    const what = await conversation.cancel(chatId);
    await tg.sendMessage(chatId, what === 'stopping'
      ? '🛑 Stopped — the agent will finish nothing further on that turn.'
      : what === 'cleared'
        ? '🧹 Cleared the queued messages.'
        : 'Nothing is running right now.');
    return;
  }

  if (text === '/help') {
    const sel = selectionOf(cs);
    await tg.sendMessage(chatId, [
      '🎬 How this bot works',
      '',
      'Just talk to me like a chat — there is no form to fill.',
      '• Give me a topic and I write the script; give me a full script and I narrate it as-is; send a voice message with your own recorded narration and the video is built from your voice (transcribed, timed, your audio as the track).',
      '• If something material is missing (style, aspect, whose voice), I will ask with buttons — I will not interrogate you when your request is already clear.',
      '• I send previews and finished videos right here in the chat. Reply in plain words to ask for changes; I revise in the same conversation.',
      '• Tell me a standing preference ("from now on, always 9:16") and I will remember it for every following video.',
      '',
      `Current model: ${sel.provider} / ${sel.model}. Turns never ask about provider or model; /model is the only place it changes.`,
      '',
      'While I work I may need a permission or a decision — that arrives as a message with buttons; just tap an answer. Nothing is ever auto-approved.',
      '',
      'Commands: /start — status • /new — fresh conversation • /model — change the current model • /cancel — stop the current turn • /help — this text',
    ].join('\n'));
    return;
  }

  // While the /model picker is open, plain text is not a turn.
  if (cs.step === 'pick-provider' || cs.step === 'pick-model') {
    if (text) await tg.sendMessage(chatId, '👆 Pick from the list above — or send /start to go back to chatting.');
    return;
  }

  // A free-text question from the agent is waiting — this message IS the
  // answer (permission requests never take free text, only buttons).
  if (text && relay.pendingTextFor(chatId)) {
    await relay.handleTextAnswer(chatId, text);
    return;
  }

  // Attachments become conversation turns (audio is transcribed first).
  const audioAtt = msg.voice || msg.audio || (msg.document?.mime_type?.startsWith('audio') ? msg.document : null);
  if (audioAtt) { await handleVoice(chatId, audioAtt, caption); return; }
  if (msg.photo?.length) { await handlePhoto(chatId, msg.photo, caption); return; }
  if (msg.document) { await handleDocument(chatId, msg.document, caption); return; }

  // Plain text IS the conversation. Never a form, never "press /start".
  if (text) {
    conversation.submit(chatId, text).catch(e => console.error('[bot] submit error:', e.message));
  }
}

async function route(u) {
  if (u.callback_query) await onCallback(u.callback_query);
  else if (u.message) await onMessage(u.message);
}

// ── Boot ────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  // Error-handling umbrella (amendment A1): log and stay alive — a stray
  // rejection in a watcher or relay must never silently kill the bot.
  process.on('unhandledRejection', e => console.error('[bot] unhandledRejection (kept alive):', e?.message || e));
  process.on('uncaughtException', e => console.error('[bot] uncaughtException (kept alive):', e?.message || e));

  if (!OWNER) console.error('[bot] WARNING: OWNER_TELEGRAM_ID not set — the bot will ignore everyone.');
  ensureMemoryFiles(); // data/memory/preferences.md + index.md starters
  startStoreServer();
  const removed = rotateStore();
  if (removed) console.log(`[store] rotated ${removed} old job(s)`);
  relay.start();
  await relay.resendPending(); // re-show any ask a restart interrupted
  outbox.start();
  // Register the "/" command menu with Telegram itself, so the owner
  // never has to configure it in BotFather. Non-fatal if it fails.
  await tg.setMyCommands([
    { command: 'start', description: 'Wake the agent / show status' },
    { command: 'new', description: 'Start a fresh conversation' },
    { command: 'model', description: 'Change the current model' },
    { command: 'cancel', description: 'Stop the current turn' },
    { command: 'help', description: 'How this bot works' },
  ]);
  console.log('[bot] polling… (owner-only, conversational)');
  // The handler is deliberately NOT awaited to completion for message
  // turns: a long agent turn must never block update processing, or the
  // permission/question buttons could not be answered while it runs.
  await tg.poll(u => { route(u).catch(e => console.error('[bot] update error:', e.message)); });
}

export { onCallback, onMessage, chatState, relay, conversation, outbox };
