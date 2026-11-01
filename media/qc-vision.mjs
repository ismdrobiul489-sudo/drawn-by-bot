// Vision QC: a render's contact sheet → NVIDIA vision model → strict JSON
// verdict { pass: boolean, issues: string[] }. One sequential request only
// (NVIDIA worker rule: never parallel).
import { readFileSync } from 'node:fs';
import { env } from '../lib/env.mjs';

const PROMPT = `You are a strict visual QC reviewer for a code-drawn animation.
Look at this contact sheet (frames sampled from one video) and judge ONLY what
is visible. Flag: empty or broken frames, shapes clipped by the frame edge,
overlapping/garbled text, objects floating without contact, holes or missing
body parts, unreadable handwriting.
Reply with JSON ONLY, no prose: {"pass": true|false, "issues": ["short issue", ...]}
pass=false only for real visible defects, not taste.`;

export async function qcContactSheet(imagePath) {
  const apiKey = env('NVIDIA_API_KEY');
  if (!apiKey) throw new Error('NVIDIA_API_KEY is not set in .env — vision QC cannot run.');
  const baseUrl = env('NVIDIA_BASE_URL', 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '');
  const model = env('NVIDIA_VISION_MODEL', 'meta/llama-3.2-11b-vision-instruct');
  const b64 = readFileSync(imagePath).toString('base64');
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
        ],
      }],
      max_tokens: 512,
      temperature: 0.1,
    }),
  });
  if (!res.ok) throw new Error(`NVIDIA vision HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const json = await res.json();
  const text = json.choices?.[0]?.message?.content || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { pass: false, issues: [`QC model returned no JSON: ${text.slice(0, 200)}`] };
  try {
    const v = JSON.parse(m[0]);
    return { pass: !!v.pass, issues: Array.isArray(v.issues) ? v.issues.map(String) : [] };
  } catch {
    return { pass: false, issues: [`QC JSON parse failed: ${text.slice(0, 200)}`] };
  }
}

// CLI: node media/qc-vision.mjs <contact-sheet.jpg>
if (import.meta.url === `file://${process.argv[1]}`) {
  const [img] = process.argv.slice(2);
  if (!img) { console.error('usage: qc-vision.mjs <image>'); process.exit(2); }
  qcContactSheet(img)
    .then(v => console.log(JSON.stringify({ ok: true, ...v })))
    .catch(e => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
}
