// TPM / token-limit fallback test. One mock HTTP server plays BOTH the
// provider APIs (every probe answers 200 — the models are ALIVE) and the
// OpenCode server (session / prompt_async / SSE /event). A prompt pinned
// to Groq fails the turn with the EXACT error the owner hit live —
// "Request too large for model `openai/gpt-oss-120b` … tokens per minute
// (TPM): Limit 8000, Requested 10703" — because Groq free's 8K TPM can
// never fit a ~10.7K-token first turn, while the 1-token probe passed.
// Asserts:
//  (a) the serve driver's session-create and prompt bodies carry the
//      JOB's provider/model (selection plumbing pin)
//  (b) TPM on the first turn → switch to the OTHER provider's .env
//      default, switch announced via status AND the persistent announce
//      hook, brief rewritten, exactly one retry, job proceeds
//  (c) TPM again after the switch → loud "Token limit on both providers"
//      failure, no third attempt
import assert from 'node:assert';
import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const SID = 'ses_tpm1';
const GROQ_TPM = 'Request too large for model `openai/gpt-oss-120b` in organization `org_test` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 10703, please reduce your message size and try again.';
const NVIDIA_TPM = 'Request too large for model `nvidia/nemotron-3-super-120b-a12b` on tokens per minute (TPM): Limit 6000, Requested 10703, please reduce your message size and try again.';

let bothTpm = false;
const sessionPosts = [];
const promptPosts = [];
const sseClients = new Set();

function emit(type, properties) {
  const data = `data: ${JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, type, properties })}\n\n`;
  for (const res of sseClients) res.write(data);
}
const emitError = message => emit('session.error', { sessionID: SID, error: { name: 'APIError', data: { message } } });

const server = createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    const url = req.url;
    const json = body ? JSON.parse(body) : {};
    // Provider API (probes): every model answers.
    if (url.endsWith('/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'chatcmpl-test', choices: [{ message: { role: 'assistant', content: '' } }] }));
      return;
    }
    // OpenCode server mock.
    if (url === '/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'evt_0', type: 'server.connected', properties: {} })}\n\n`);
      sseClients.add(res);
      res.on('close', () => sseClients.delete(res));
      return;
    }
    if (url === '/session/status') { res.end('{}'); return; }
    if (url === '/session' && req.method === 'POST') {
      sessionPosts.push(json);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: SID, title: json.title || '' }));
      return;
    }
    if (url === `/session/${SID}/prompt_async`) {
      promptPosts.push(json);
      res.writeHead(204); res.end();
      const provider = json.model?.providerID;
      setTimeout(() => {
        if (provider === 'groq') emitError(GROQ_TPM);
        else if (provider === 'nvidia' && bothTpm) emitError(NVIDIA_TPM);
        else emit('session.idle', { sessionID: SID });
      }, 80);
      return;
    }
    if (url === '/permission' || url === '/question') { res.end('[]'); return; }
    res.writeHead(404); res.end('{}');
  });
});
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

// Env BEFORE importing the processor (the agentServer singleton reads
// OPENCODE_SERVER_URL at construction, env() reads at call time).
process.env.GROQ_API_KEY = 'test-groq-key';
process.env.NVIDIA_API_KEY = 'test-nvidia-key';
process.env.GROQ_BASE_URL = `${base}/v1`;
process.env.NVIDIA_BASE_URL = `${base}/v1`;
process.env.GROQ_DEFAULT_MODEL = 'openai/gpt-oss-120b';
process.env.NVIDIA_DEFAULT_MODEL = 'nvidia/nemotron-3-super-120b-a12b';
process.env.OPENCODE_SERVER_URL = base;
delete process.env.OPENCODE_DRIVER;
delete process.env.MODEL_PROBE;

const { processJob } = await import('../bot/processor.mjs');
const { agentServer } = await import('../bot/agent-server.mjs');

const mkHooks = () => {
  const statuses = [];
  const announcements = [];
  return {
    statuses, announcements,
    status: async t => { statuses.push(t); },
    announce: async t => { announcements.push(t); },
  };
};
const mkJob = (id, slug) => ({
  id, chatId: 42, mode: 'topic', inputText: slug,
  provider: 'groq', model: 'openai/gpt-oss-120b',
  style: 'paper-cutout', aspect: '9:16', voice: 'en-US-AriaNeural',
  finalNow: false, createdAt: Date.now(),
});

const jobDirs = [];
try {
  // (b) TPM on Groq → one switch to NVIDIA default → turn succeeds there
  // (processJob then stops at "no .mp4", which proves the turn completed
  // and the pipeline moved past it — the mock agent renders nothing).
  const hooks1 = mkHooks();
  const job1 = mkJob('job-tpm-1', 'tpm switch topic');
  await assert.rejects(() => processJob(job1, hooks1), /no \.mp4 was found/);
  jobDirs.push(job1.jobDir);
  assert.equal(job1.provider, 'nvidia');
  assert.equal(job1.model, 'nvidia/nemotron-3-super-120b-a12b');
  assert.equal(job1.tpmSwitched, true);
  assert.equal(promptPosts.length, 2, 'exactly one retry after the switch');
  const switchLine = t => t.includes('hit its free token limit') && t.includes('switched to nvidia/nvidia/nemotron-3-super-120b-a12b') && t.includes('Job continues');
  assert.ok(hooks1.statuses.some(switchLine), 'switch announced via status');
  assert.ok(hooks1.announcements.some(switchLine), 'switch ALSO announced as a persistent message');
  const brief = readFileSync(join(job1.jobDir, 'brief.md'), 'utf8');
  assert.ok(brief.includes('OpenCode model id: nvidia/nvidia/nemotron-3-super-120b-a12b'), 'brief rewritten to the model that actually ran');
  console.log('  ✓ (b) TPM first turn → switch to other provider\'s .env default + notice (status + announce) + brief rewritten + one retry, job proceeds');

  // (a) the serve plumbing pinned the JOB's provider/model into both the
  // session-create body and every prompt body — no config override.
  assert.deepEqual(sessionPosts[0].model, { id: 'openai/gpt-oss-120b', providerID: 'groq' });
  assert.deepEqual(promptPosts[0].model, { providerID: 'groq', modelID: 'openai/gpt-oss-120b' });
  assert.deepEqual(promptPosts[1].model, { providerID: 'nvidia', modelID: 'nvidia/nemotron-3-super-120b-a12b' });
  console.log('  ✓ (a) serve-driver session + prompt bodies carry the job\'s provider/model verbatim');

  // (c) TPM on BOTH providers → loud named failure, no third attempt.
  bothTpm = true;
  const hooks2 = mkHooks();
  const job2 = mkJob('job-tpm-2', 'tpm both topic');
  await assert.rejects(() => processJob(job2, hooks2),
    /Token limit on both providers: Groq could not fit this job.*gpt-oss-120b.*nvidia\/nvidia\/nemotron-3-super-120b-a12b hit the same limit/s);
  jobDirs.push(job2.jobDir);
  assert.equal(job2.tpmSwitched, true);
  assert.equal(promptPosts.length, 4, 'two attempts for job 2 — no third attempt');
  assert.equal(hooks2.announcements.filter(switchLine).length, 1, 'exactly one switch was announced');
  console.log('  ✓ (c) TPM after the switch → loud "Token limit on both providers" failure, no third attempt');
} finally {
  agentServer.stop();
  server.close();
  for (const d of jobDirs) { if (d && existsSync(d)) rmSync(d, { recursive: true, force: true }); }
}
