// Relay test: mock OpenCode server (session / prompt_async / SSE /event /
// permission + question replies — shapes verified against OpenCode 1.19.5's
// own OpenAPI doc) + a recording fake Telegram. Asserts:
//  (a) a permission.asked event produces a Telegram message with the three
//      labelled buttons (✅ Yes / ♾️ Always for this job / ❌ No)
//  (b) tapping ✅ Yes POSTs { response: "once" } to the right endpoint
//  (c) a question with options produces one button per option, and tapping
//      one replies with { answers: [[label]] }; a no-option question takes
//      the owner's next text message as the answer
//  (The old (d) run-driver assertion was removed with the run driver
//  itself in the conversational rework — serve is the only driver now.)
import assert from 'node:assert';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentServer } from '../bot/agent-server.mjs';
import { AskRelay } from '../bot/relay.mjs';

const SID = 'ses_test1';
const posts = [];       // { path, body } recorded from the driver + relay
const sseClients = new Set();
let promptCount = 0;

function emit(type, properties) {
  const data = `data: ${JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, type, properties })}\n\n`;
  for (const res of sseClients) res.write(data);
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    const url = req.url;
    const json = body ? JSON.parse(body) : {};
    if (url === '/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'evt_0', type: 'server.connected', properties: {} })}\n\n`);
      sseClients.add(res);
      res.on('close', () => sseClients.delete(res)); // req 'close' fires instantly on bodyless GETs
      return;
    }
    if (url === '/session/status') { res.end('{}'); return; }
    if (url === '/session' && req.method === 'POST') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: SID, title: json.title || '' }));
      return;
    }
    if (url === `/session/${SID}/prompt_async`) {
      posts.push({ path: url, body: json });
      promptCount += 1;
      res.writeHead(204); res.end();
      const n = promptCount;
      setTimeout(() => {
        if (n === 1) emit('permission.asked', {
          id: 'per_test1', sessionID: SID, permission: 'bash',
          patterns: ['node engine/render.mjs *'],
          metadata: { command: 'node engine/render.mjs sandbox/job/scene.js' },
          always: ['node engine/render.mjs *'], tool: { messageID: 'msg_1', callID: 'call_1' },
        });
        if (n === 2) emit('question.asked', {
          id: 'que_test1', sessionID: SID,
          questions: [{ question: 'Which colour should the sky be?', header: 'Sky colour',
            options: [{ label: 'Red', description: 'warm sunset' }, { label: 'Blue', description: 'calm morning' }] }],
          tool: { messageID: 'msg_2', callID: 'call_2' },
        });
        if (n === 3) emit('question.asked', {
          id: 'que_test2', sessionID: SID,
          questions: [{ question: 'Any note for the ending?', header: 'Note', options: [] }],
          tool: { messageID: 'msg_3', callID: 'call_3' },
        });
      }, 60);
      return;
    }
    if (url === `/session/${SID}/permissions/per_test1`) {
      posts.push({ path: url, body: json });
      res.end('true');
      setTimeout(() => { emit('permission.replied', { sessionID: SID, requestID: 'per_test1', reply: json.response }); emit('session.idle', { sessionID: SID }); }, 30);
      return;
    }
    if (url === '/question/que_test1/reply' || url === '/question/que_test2/reply') {
      posts.push({ path: url, body: json });
      res.end('true');
      const qid = url.split('/')[2];
      setTimeout(() => { emit('question.replied', { sessionID: SID, requestID: qid, answers: json.answers }); emit('session.idle', { sessionID: SID }); }, 30);
      return;
    }
    if (url === '/permission' || url === '/question') { res.end('[]'); return; }
    res.writeHead(404); res.end('{}');
  });
});
await new Promise(r => server.listen(0, r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

// Recording fake Telegram.
function fakeTg() {
  const calls = { sent: [], edits: [] };
  return {
    calls,
    async sendMessage(chatId, text, replyMarkup) {
      const m = { message_id: 500 + calls.sent.length, chat_id: chatId, text, reply_markup: replyMarkup };
      calls.sent.push(m);
      return m;
    },
    async editMessageText(chatId, messageId, text) { calls.edits.push({ chat_id: chatId, message_id: messageId, text }); return {}; },
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(pred, what, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (pred()) return; await sleep(100); }
  throw new Error(`timeout waiting for: ${what}`);
}
async function withTimeout(p, what) {
  let t; const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`turn did not finish: ${what}`)), 8000); });
  try { return await Promise.race([p, timeout]); } finally { clearTimeout(t); }
}
const kbButtons = m => (m?.reply_markup?.inline_keyboard || []).flat();
const postTo = path => posts.find(p => p.path === path);

const tmp = mkdtempSync(join(tmpdir(), 'relay-test-'));
const pendingFile = join(tmp, 'pending.json');
const tg = fakeTg();
const agent = new AgentServer({ baseUrl });
const relay = new AskRelay({ tg, agent, pendingFile, remindAfterMs: 10 ** 12 });

try {
  const sessionId = await agent.createSession({ providerID: 'groq', modelID: 'openai/gpt-oss-120b', title: 'job-1' });
  assert.equal(sessionId, SID);
  relay.attach(sessionId, 42, 'job-1');

  // (a) permission.asked → Telegram message with the 3 labelled buttons.
  const turn1 = agent.prompt(sessionId, 'make the video', { providerID: 'groq', modelID: 'openai/gpt-oss-120b' });
  await waitFor(() => tg.calls.sent.some(m => m.text.includes('Permission needed')), 'permission message');
  const permMsg = tg.calls.sent.find(m => m.text.includes('Permission needed'));
  assert.ok(permMsg.text.includes('bash') && permMsg.text.includes('node engine/render.mjs'), 'message describes the ask');
  const btns = kbButtons(permMsg);
  assert.deepEqual(btns.map(b => b.text), ['✅ Yes', '❌ No', '♾️ Always for this job']);
  assert.deepEqual(btns.map(b => b.callback_data), ['perm:per_test1:once', 'perm:per_test1:reject', 'perm:per_test1:always']);
  console.log('  ✓ (a) permission event → Telegram message with ✅ Yes / ❌ No / ♾️ Always buttons');

  // Persistence: the ask is on disk, and a fresh relay re-sends it.
  assert.ok(existsSync(pendingFile) && JSON.parse(readFileSync(pendingFile, 'utf8')).some(e => e.id === 'per_test1'), 'pending ask persisted');
  const tg2 = fakeTg();
  const relay2 = new AskRelay({ tg: tg2, agent, pendingFile, remindAfterMs: 10 ** 12 });
  await relay2.resendPending();
  assert.ok(tg2.calls.sent.some(m => m.text.includes('Permission needed')), 'restarted relay re-sends the ask');
  relay2.dispose();
  console.log('  ✓ pending asks persist to disk and are re-sent after a restart');

  // (b) tapping ✅ Yes POSTs { response: "once" } to the session endpoint.
  assert.equal(await relay.handleCallback(42, 'perm:per_test1:once'), true);
  assert.deepEqual(postTo(`/session/${SID}/permissions/per_test1`)?.body, { response: 'once' });
  assert.ok(tg.calls.edits.some(e => e.text.includes('Yes (this time only)')), 'decision shown on the message');
  await withTimeout(turn1, 'permission turn');
  console.log('  ✓ (b) ✅ Yes tap → POST {response:"once"} to the permission endpoint, turn completes');

  // (c1) question with options → one button per option; tap replies by label.
  const turn2 = agent.prompt(sessionId, 'continue', { providerID: 'groq', modelID: 'openai/gpt-oss-120b' });
  await waitFor(() => tg.calls.sent.some(m => m.text.includes('Which colour')), 'question message');
  const qMsg = tg.calls.sent.find(m => m.text.includes('Which colour'));
  assert.deepEqual(kbButtons(qMsg).map(b => b.callback_data), ['q:que_test1:0', 'q:que_test1:1']);
  assert.deepEqual(kbButtons(qMsg).map(b => b.text), ['Red', 'Blue']);
  assert.equal(await relay.handleCallback(42, 'q:que_test1:1'), true);
  assert.deepEqual(postTo('/question/que_test1/reply')?.body, { answers: [['Blue']] });
  assert.ok(tg.calls.edits.some(e => e.text.includes('Your answer: Blue')), 'chosen answer shown');
  await withTimeout(turn2, 'question turn');
  console.log('  ✓ (c) question options → one button each; tap replies {answers:[[label]]}');

  // (c2) question without options → the owner's next text message answers it.
  const turn3 = agent.prompt(sessionId, 'continue again', { providerID: 'groq', modelID: 'openai/gpt-oss-120b' });
  await waitFor(() => relay.pendingTextFor(42), 'free-text question pending');
  assert.equal(await relay.handleTextAnswer(42, 'soft piano at the end'), true);
  assert.deepEqual(postTo('/question/que_test2/reply')?.body, { answers: [['soft piano at the end']] });
  await withTimeout(turn3, 'free-text question turn');
  console.log('  ✓ (c) no-option question → owner\'s next text message is the answer');

} finally {
  relay.dispose();
  agent.stop();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}
