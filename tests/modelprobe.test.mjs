// Model probe + fallback test. One mock HTTP server plays BOTH providers
// (routed by the Authorization key): /chat/completions answers 200 only
// for models outside the mutable `dead` set, 404 for the rest — the exact
// failure the user hit on NVIDIA (listed in /models, dead when called).
// Asserts:
//  (a) probeModel ok/fail + success/failure caching
//  (b) chain: chosen dead → provider .env default, notify called
//  (c) chosen + own default dead → other provider's default
//  (d) everything dead → { provider: null }, every try recorded
//  (e) processor seam: ensureWorkingModel rewrites the job to the fallback
//      with an owner notice, leaves a healthy job alone, and throws loudly
//      (naming every tried model) when nothing answers
//  (f) MODEL_PROBE=off skips the network entirely
import assert from 'node:assert';
import { createServer } from 'node:http';

const KEYS = { groq: 'test-groq-key', nvidia: 'test-nvidia-key' };
const dead = new Set(['bad-groq', 'bad-nvidia']);
const counts = new Map(); // "provider|model" -> request count

const server = createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    if (req.url.endsWith('/chat/completions')) {
      const who = Object.entries(KEYS).find(([, k]) => (req.headers.authorization || '') === `Bearer ${k}`)?.[0];
      let model = '';
      try { model = JSON.parse(body || '{}').model || ''; } catch { /* no model */ }
      if (who) counts.set(`${who}|${model}`, (counts.get(`${who}|${model}`) || 0) + 1);
      if (!who || dead.has(model)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `model ${model} not found` } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'chatcmpl-test', choices: [{ message: { role: 'assistant', content: '' } }] }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
});
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/v1`;

// Env BEFORE calling into the modules (env() reads process.env at call time).
process.env.GROQ_API_KEY = KEYS.groq;
process.env.NVIDIA_API_KEY = KEYS.nvidia;
process.env.GROQ_BASE_URL = base;
process.env.NVIDIA_BASE_URL = base;
process.env.GROQ_DEFAULT_MODEL = 'good-groq';
process.env.NVIDIA_DEFAULT_MODEL = 'good-nvidia';
process.env.MODELS_CACHE_TTL_SEC = '900';
delete process.env.MODEL_PROBE;

const { probeModel, resolveWorkingModel, clearProbeCache } = await import('../bot/models.mjs');
const { ensureWorkingModel } = await import('../bot/processor.mjs');

const hits = (who, model) => counts.get(`${who}|${model}`) || 0;

try {
  // (a) probe + caching
  assert.deepEqual(await probeModel('groq', 'good-groq'), { ok: true });
  const bad = await probeModel('groq', 'bad-groq');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /404/);
  await probeModel('groq', 'good-groq');
  await probeModel('groq', 'bad-groq');
  assert.equal(hits('groq', 'good-groq'), 1, 'successful probe is cached for the models TTL');
  assert.equal(hits('groq', 'bad-groq'), 1, 'failed probe is cached for 60 s');
  console.log('  ✓ (a) probeModel: 2xx → ok, 404 → error with status; both outcomes cached');

  // (b) chosen dead → provider default, notify called
  const notes = [];
  const rb = await resolveWorkingModel('groq', 'bad-groq', t => notes.push(t));
  assert.equal(rb.provider, 'groq');
  assert.equal(rb.model, 'good-groq');
  assert.equal(rb.fellBack, true);
  assert.equal(rb.tried.length, 2);
  assert.ok(notes.some(t => t.includes('bad-groq') && t.includes('trying groq/good-groq')), 'notify explains the fallback step');
  console.log('  ✓ (b) dead chosen model → provider .env default + notify called');

  // (c) chosen + own default dead → other provider's default
  dead.add('good-nvidia');
  const rc = await resolveWorkingModel('nvidia', 'bad-nvidia', () => {});
  assert.equal(rc.provider, 'groq');
  assert.equal(rc.model, 'good-groq');
  assert.equal(rc.fellBack, true);
  assert.equal(rc.tried.length, 3);
  console.log('  ✓ (c) chosen + own default dead → other provider\'s default (provider switches)');

  // (d) everything dead → provider null
  clearProbeCache();
  dead.add('good-groq');
  const rd = await resolveWorkingModel('groq', 'bad-groq', () => {});
  assert.equal(rd.provider, null);
  assert.equal(rd.tried.length, 3);
  assert.ok(rd.tried.every(t => !t.ok && t.error), 'every tried model carries its error');
  console.log('  ✓ (d) all models dead → { provider: null }, all tries recorded');

  // (e) processor seam: ensureWorkingModel
  clearProbeCache();
  dead.delete('good-groq'); dead.delete('good-nvidia');
  const msgs = [];
  const hooks = { status: async t => { msgs.push(t); } };
  const job = { id: 'job-probe', provider: 'groq', model: 'bad-groq', chatId: 42 };
  const re = await ensureWorkingModel(job, hooks);
  assert.equal(re.fellBack, true);
  assert.equal(job.provider, 'groq');
  assert.equal(job.model, 'good-groq', 'job now runs on the fallback model');
  assert.equal(job.modelFellBack, true);
  assert.ok(msgs.some(t => t.includes("didn't respond") && t.includes('switched to groq/good-groq')), 'owner got the switch notice');
  const jobOk = { id: 'job-fine', provider: 'nvidia', model: 'good-nvidia', chatId: 42 };
  const reOk = await ensureWorkingModel(jobOk, hooks);
  assert.equal(reOk.fellBack, false);
  assert.equal(jobOk.model, 'good-nvidia', 'healthy job is left untouched');
  clearProbeCache();
  dead.add('good-groq'); dead.add('good-nvidia');
  const jobDead = { id: 'job-dead', provider: 'groq', model: 'bad-groq', chatId: 42 };
  await assert.rejects(() => ensureWorkingModel(jobDead, hooks),
    /No working model found.*groq\/bad-groq.*groq\/good-groq.*nvidia\/good-nvidia/s);
  console.log('  ✓ (e) ensureWorkingModel: job rewritten + notice on fallback; loud throw naming all tries when nothing works');

  // (f) MODEL_PROBE=off
  process.env.MODEL_PROBE = 'off';
  const beforeHits = hits('groq', 'bad-groq');
  const off = await probeModel('groq', 'bad-groq');
  assert.equal(off.ok, true);
  assert.equal(hits('groq', 'bad-groq'), beforeHits, 'no request is made while the probe is off');
  delete process.env.MODEL_PROBE;
  console.log('  ✓ (f) MODEL_PROBE=off skips the probe entirely');
} finally {
  server.close();
}
