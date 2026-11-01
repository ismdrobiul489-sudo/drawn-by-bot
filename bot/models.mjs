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
