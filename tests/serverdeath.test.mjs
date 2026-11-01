// Server-death test (amendment A2): the OpenCode serve process is KILLED
// mid-conversation — once while idle, once in the middle of a turn.
// Asserts the full recovery contract:
//  • agent-server respawns the process on its own,
//  • the bridge re-attaches to the PERSISTED session (the fake server
//    reloads session ids from a state file, like OpenCode's real store),
//  • the owner gets exactly ONE "Agent restarted — our conversation is
//    intact." notice per death episode, and never a failure message,
//  • a mid-turn death fails the in-flight wait with a serverDied error
//    and the bridge's guard retries the turn on the respawned server.
import assert from 'node:assert';
import { createServer as netServer } from 'node:net';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'dbb-death-'));
const stateFile = join(tmp, 'fake-sessions.json');
const hangFlag = join(tmp, 'hang-next');
const promptedMark = join(tmp, 'prompted');

const freePort = await new Promise(resolvePort => {
  const s = netServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolvePort(p)); });
});

// Fake `opencode` binary. If the hang flag file exists AT STARTUP, this
// process's first prompt never completes (and the flag is consumed) —
// so a kill during that prompt is a true mid-turn death, while the
// NEXT respawned process answers normally.
const fakeBin = join(tmp, 'fake-opencode');
writeFileSync(fakeBin, `#!/usr/bin/env node
const http = require('node:http');
const fs = require('node:fs');
const stateFile = process.env.FAKE_OC_STATE;
const hangFlag = process.env.FAKE_OC_HANGFLAG;
const promptedMark = process.env.FAKE_OC_PROMPTED;
let sessions = new Set();
try { sessions = new Set(JSON.parse(fs.readFileSync(stateFile, 'utf8'))); } catch {}
let hangFirst = false;
try { if (fs.existsSync(hangFlag)) { hangFirst = true; fs.rmSync(hangFlag); } } catch {}
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
let sse = null;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const drain = cb => { const ch = []; req.on('data', d => ch.push(d)); req.on('end', cb); };
  if (url.pathname === '/global/health') return json(200, { healthy: true, version: 'fake' });
  if (url.pathname === '/session/status') return json(200, {});
  if (url.pathname === '/event') { res.writeHead(200, { 'content-type': 'text/event-stream' }); sse = res; return; }
  if (req.method === 'POST' && url.pathname === '/session') return drain(() => {
    sessions.add('ses_fake_1');
    fs.writeFileSync(stateFile, JSON.stringify([...sessions]));
    json(200, { id: 'ses_fake_1', directory: url.searchParams.get('directory') || '' });
  });
  if (req.method === 'GET' && url.pathname === '/session/ses_fake_1') {
    return sessions.has('ses_fake_1') ? json(200, { id: 'ses_fake_1' }) : json(404, { error: 'no session' });
  }
  if (req.method === 'POST' && url.pathname.includes('/prompt_async')) return drain(() => {
    json(204, {});
    try { fs.writeFileSync(promptedMark, String(Date.now())); } catch {}
    if (hangFirst) { hangFirst = false; return; } // never idles — the kill lands mid-turn
    setTimeout(() => { try {
      sse?.write('data: ' + JSON.stringify({ type: 'message.part.delta', properties: { sessionID: 'ses_fake_1', messageID: 'm' + Date.now(), partID: 'p', field: 'text', delta: 'fake reply' } }) + '\\n\\n');
      sse?.write('data: ' + JSON.stringify({ type: 'session.idle', properties: { sessionID: 'ses_fake_1' } }) + '\\n\\n');
    } catch {} }, 30);
  });
  if (url.pathname.includes('/abort')) return json(200, true);
  return json(404, { error: 'nf' });
});
server.listen(port, '127.0.0.1');
`);
chmodSync(fakeBin, 0o755);

process.env.OPENCODE_BIN = fakeBin;
process.env.OPENCODE_PORT = String(freePort);
process.env.OPENCODE_SERVER_CWD = tmp;
process.env.OPENCODE_READY_POLL_MS = '100';
process.env.FAKE_OC_STATE = stateFile;
process.env.FAKE_OC_HANGFLAG = hangFlag;
process.env.FAKE_OC_PROMPTED = promptedMark;
delete process.env.OPENCODE_SERVER_URL;
process.env.MODEL_PROBE = 'off'; // probes are the modelprobe group's job

const { AgentServer } = await import('../bot/agent-server.mjs');
const { Conversation } = await import('../bot/conversation.mjs');

const sent = [];
const tg = {
  sendMessage: async (chatId, text) => { sent.push(text); return { message_id: sent.length }; },
  editMessageText: async () => true,
  sendChatAction: async () => true,
};
const state = {};
const agent = new AgentServer();
const conv = new Conversation({
  tg, agent,
  chatState: id => (state[id] ||= { step: 'idle' }),
  saveState: () => {},
  selectionOf: cs => (cs.selection ??= { provider: 'groq', model: 'openai/gpt-oss-120b' }),
  setSelection: (cs, sel) => { cs.selection = { ...sel }; },
  sessionDirectory: tmp,
  settleMs: 50,
  outbox: { arrivedCount: 0 },
});


const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, what, ms = 25000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await sleep(60); }
}
const notices = () => sent.filter(t => t.includes('Agent restarted — our conversation is intact.')).length;
const replies = () => sent.filter(t => t.includes('fake reply')).length;

try {
  // Turn 1: normal.
  await conv.submit(555, 'hello agent');
  await waitFor(() => replies() === 1, 'first reply');
  assert.equal(state[555].sessionId, 'ses_fake_1', 'session persisted in chat state');
  const childA = agent.child;
  assert.ok(childA && !childA.killed, 'server process running');

  // ── Death 1: idle kill → respawn + re-attach + ONE notice ──
  childA.kill('SIGKILL');
  await waitFor(() => agent.child && agent.child !== childA, 'server respawned after idle death');
  await waitFor(() => notices() === 1, 'one restart notice for the idle death');
  assert.ok(!sent.some(t => t.includes('could not finish')), 'no failure shown for an idle death');

  // Turn 2: same session continues on the respawned server.
  await conv.submit(555, 'still there?');
  await waitFor(() => replies() === 2, 'second reply after respawn');
  assert.equal(state[555].sessionId, 'ses_fake_1', 'same session id after respawn');

  // ── Death 2: MID-TURN kill → waiter fails serverDied → guard retries ──
  writeFileSync(hangFlag, '1');            // the NEXT server process will hang its first prompt
  const childB = agent.child;
  childB.kill('SIGKILL');                  // respawn (child C) picks up the hang flag
  await waitFor(() => agent.child && agent.child !== childB, 'server respawned with hang armed');
  await waitFor(() => notices() === 2, 'one notice for the second death');
  rmSync(promptedMark, { force: true });
  const turn3 = conv.submit(555, 'third message');
  await waitFor(() => existsSync(promptedMark), 'turn 3 prompt reached the hanging server');
  const childC = agent.child;
  childC.kill('SIGKILL');                  // ← the mid-turn death
  await turn3;                             // submit resolves once the pump drains
  await waitFor(() => replies() === 3, 'guard retried the turn on the respawned server and it answered');
  assert.equal(state[555].sessionId, 'ses_fake_1', 'same session id after the mid-turn death');
  assert.ok(!sent.some(t => t.includes('could not finish')), 'no failure shown for the mid-turn death');
  await sleep(600);
  assert.ok(notices() <= 3, `restart notices stay one-per-episode (got ${notices()})`);
  console.log('  ✓ idle death + mid-turn death → respawn, re-attach to persisted session, notice, guard retry succeeds');
} finally {
  try { agent.stop(); } catch {}
  rmSync(tmp, { recursive: true, force: true });
}
console.log('serverdeath: passed');
