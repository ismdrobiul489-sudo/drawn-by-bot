// Dynamic provider model lists. The bot NEVER hardcodes model names for the
// selection step: it fetches the provider's /models with the configured key
// and shows what that key can actually use (keys differ — on the user's
// NVIDIA key 46 catalog models return 404; on Groq, Llama 3.3 vanished).
// Lists are cached for MODELS_CACHE_TTL_SEC with a manual refresh button.
import { env, envInt } from '../lib/env.mjs';

// Ids containing any of these are not chat/scene-writing models.
const EXCLUDE = [
  'whisper', 'tts', 'orpheus', 'embed', 'nvclip', 'clip', 'parse',
  'safety', 'guard', 'riva', 'translate', 'rerank', 'reward', 'ocr',
  'deplot', 'caption', 'vila', 'kosmos', 'fuyu', 'neva', 'sdxl', 'diffusion',
];

/** Pure filter: /models payload (OpenAI-style {data:[{id}]}) → chat model ids. */
export function filterChatModels(payload) {
  const ids = (payload?.data || []).map(m => (typeof m === 'string' ? m : m.id)).filter(Boolean);
  return ids.filter(id => {
    const low = id.toLowerCase();
    return !EXCLUDE.some(x => low.includes(x));
  }).sort();
}

const cache = new Map(); // provider -> { at, models }

export const PROVIDERS = {
  groq: {
    label: 'Groq',
    baseUrl: () => env('GROQ_BASE_URL', 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
    key: () => env('GROQ_API_KEY'),
    defaultModel: () => env('GROQ_DEFAULT_MODEL', 'openai/gpt-oss-120b'),
  },
  nvidia: {
    label: 'NVIDIA',
    baseUrl: () => env('NVIDIA_BASE_URL', 'https://integrate.api.nvidia.com/v1').replace(/\/$/, ''),
    key: () => env('NVIDIA_API_KEY'),
    defaultModel: () => env('NVIDIA_DEFAULT_MODEL', 'nvidia/nemotron-3-super-120b-a12b'),
  },
};

// ── Model health probe + fallback chain ─────────────────────────────────────
// A model can sit in a provider's /models list and still be dead when
// called (46 NVIDIA catalog models 404 on the user's key). Before a job
// starts, the chosen model is verified with a 1-token chat completion;
// a dead model falls back automatically (see resolveWorkingModel) — the
// job never just dies in silence.
const probeCache = new Map(); // "provider/model" -> { at, result }
const PROBE_TIMEOUT_MS = 20000;
const PROBE_FAIL_TTL_MS = 60000; // failures recover fast; successes use the models TTL

/** Forget all cached probe results (tests, key rotation). */
export function clearProbeCache() { probeCache.clear(); }

/**
 * One-token liveness check of a chat model via the provider's own API.
 * { ok: true } on any 2xx; { ok: false, error } otherwise. Successes are
 * cached for MODELS_CACHE_TTL_SEC, failures for only 60 s. Skipped
 * entirely when MODEL_PROBE=off in .env.
 */
export async function probeModel(provider, modelId) {
  const p = PROVIDERS[provider];
  if (!p) return { ok: false, error: `Unknown provider "${provider}"` };
  if (env('MODEL_PROBE', 'on').trim().toLowerCase() === 'off') return { ok: true, skipped: true };
  const cacheKey = `${provider}/${modelId}`;
  const hit = probeCache.get(cacheKey);
  if (hit) {
    const ttl = hit.result.ok ? envInt('MODELS_CACHE_TTL_SEC', 900) * 1000 : PROBE_FAIL_TTL_MS;
    if (Date.now() - hit.at < ttl) return hit.result;
  }
  const key = p.key();
  let result;
  if (!key) {
    result = { ok: false, error: `${p.label} API key is missing in .env` };
  } else {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(`${p.baseUrl()}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
        signal: ctl.signal,
      });
      if (res.ok) {
        result = { ok: true };
      } else {
        const body = (await res.text().catch(() => '')).slice(0, 300);
        let detail = body;
        try { detail = JSON.parse(body)?.error?.message || body; } catch { /* keep raw body */ }
        result = { ok: false, error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 200)}` : ''}` };
      }
    } catch (e) {
      result = { ok: false, error: e.name === 'AbortError' ? `no answer within ${PROBE_TIMEOUT_MS / 1000}s` : e.message };
    } finally {
      clearTimeout(timer);
    }
  }
  probeCache.set(cacheKey, { at: Date.now(), result });
  return result;
}

/**
 * Find a model that actually answers, in this order:
 *   1. the requested model on the requested provider
 *   2. that provider's default model from .env
 *   3. the OTHER provider's default model from .env
 * `notify(text)` is awaited with a plain-English explanation at every step
 * where a model turns out dead. `skip` holds "provider/model" strings to
 * leave out (a model that just failed mid-turn). Returns
 * { provider, model, fellBack, tried } — provider is null when nothing
 * answered at all; tried lists every probe outcome, errors included.
 */
export async function resolveWorkingModel(provider, modelId, notify = () => {}, { skip = [] } = {}) {
  if (!PROVIDERS[provider]) return { provider: null, model: null, fellBack: false, tried: [] };
  const other = provider === 'groq' ? 'nvidia' : 'groq';
  const seen = new Set(skip);
  const candidates = [];
  for (const c of [
    { provider, model: modelId },
    { provider, model: PROVIDERS[provider].defaultModel() },
    { provider: other, model: PROVIDERS[other].defaultModel() },
  ]) {
    const id = `${c.provider}/${c.model}`;
    if (c.model && !seen.has(id)) { seen.add(id); candidates.push(c); }
  }
  const tried = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const r = await probeModel(c.provider, c.model);
    tried.push({ provider: c.provider, model: c.model, ok: r.ok, ...(r.ok ? {} : { error: r.error }) });
    if (r.ok) return { provider: c.provider, model: c.model, fellBack: i > 0, tried };
    const next = candidates[i + 1];
    await notify(next
      ? `Model ${c.provider}/${c.model} didn't respond (${r.error}) — trying ${next.provider}/${next.model} instead.`
      : `Model ${c.provider}/${c.model} didn't respond (${r.error}) — no fallback left.`);
  }
  return { provider: null, model: null, fellBack: false, tried };
}

/** Live (or TTL-cached) chat model list for a provider. */
export async function listModels(provider, { refresh = false } = {}) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unknown provider "${provider}"`);
  const key = p.key();
  if (!key) throw new Error(`${p.label} API key is missing in .env — add the key first.`);
  const ttl = envInt('MODELS_CACHE_TTL_SEC', 900) * 1000;
  const hit = cache.get(provider);
  if (!refresh && hit && Date.now() - hit.at < ttl) return { models: hit.models, cached: true };
  const res = await fetch(`${p.baseUrl()}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`${p.label} /models HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const models = filterChatModels(await res.json());
  cache.set(provider, { at: Date.now(), models });
  return { models, cached: false };
}
