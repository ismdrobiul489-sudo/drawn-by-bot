// check-models — which of YOUR models are actually alive today?
//
//   node scripts/check-models.mjs
//
// A model can sit in a provider's live /models list and still be dead when
// called (de-provisioned → HTTP 404, or hung → no answer). This script
// probes a short list of known candidates with the same 1-token chat
// completion the bot's pre-job probe uses (bot/models.mjs probeModel),
// one by one, and ends with the first ALIVE model per provider as
// ready-to-paste .env lines.
//
// NOTE: the candidate lists below are only what this CHECKER tries — the
// bot itself never hardcodes model names; its selection list is fetched
// live from each provider's /models (see bot/models.mjs).
//
// Keys come from .env (via lib/env.mjs) and are never printed.
// Exit code: 0 for a completed report (dead models included), 1 only
// when a key/config is missing.

// The checker must really probe even if .env sets MODEL_PROBE=off for the
// bot — a real environment value wins over the .env file in lib/env.mjs,
// so pin it here before anything reads the config.
process.env.MODEL_PROBE = 'on';

const { envInt } = await import('../lib/env.mjs');
const { probeModel, PROVIDERS } = await import('../bot/models.mjs');

// Candidates per provider: the .env default first, then the extras.
const EXTRA_CANDIDATES = {
  nvidia: [
    'z-ai/glm-5.3',
    'nvidia/nemotron-3-ultra-550b-a55b',
    'meta/muse-glimmer-30b',
    'openai/gpt-oss-20b',
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
  ],
  groq: [
    'openai/gpt-oss-20b',
    'qwen/qwen3.8-27b',
  ],
};
// Probe NVIDIA first (it's the provider that can drive jobs today), then
// Groq; everything strictly sequential — the NVIDIA account limits punish
// parallel calls, and sequential keeps Groq's free TPM untouched too.
const ORDER = ['nvidia', 'groq'];

const candidatesOf = provider => [...new Set([PROVIDERS[provider].defaultModel(), ...EXTRA_CANDIDATES[provider]])];

const missing = ORDER.filter(p => !PROVIDERS[p].key());
if (missing.length) {
  for (const p of missing) console.error(`✗ ${PROVIDERS[p].label} API key is missing in .env — add it first.`);
  process.exit(1);
}

const timeoutSec = Math.max(1, envInt('PROBE_TIMEOUT_SEC', 45));
console.log(`Checking your models — one 1-token probe each, up to ${timeoutSec}s per model, sequentially.\n`);

const firstAlive = {};
for (const provider of ORDER) {
  for (const model of candidatesOf(provider)) {
    const r = await probeModel(provider, model);
    if (r.ok) {
      console.log(`✓ ${provider.padEnd(6)}  ${model}`);
      if (!firstAlive[provider]) firstAlive[provider] = model;
    } else {
      const err = String(r.error || 'no answer').replace(/\s+/g, ' ').slice(0, 120);
      console.log(`✗ ${provider.padEnd(6)}  ${model} — ${err}`);
    }
  }
}

console.log('\n── Recommendation ─────────────────────────────────────────────');
console.log('First alive model per provider. Paste the line(s) into .env,');
console.log('or pick the same model in the bot with /model:\n');
for (const provider of ORDER) {
  const varName = provider === 'nvidia' ? 'NVIDIA_DEFAULT_MODEL' : 'GROQ_DEFAULT_MODEL';
  if (firstAlive[provider]) {
    console.log(`${varName}=${firstAlive[provider]}`);
  } else {
    console.log(`${PROVIDERS[provider].label}: NO candidate answered — this key currently has no working`);
    console.log(`chat model among the ones checked, so no ${varName} line can be recommended.`);
  }
}
