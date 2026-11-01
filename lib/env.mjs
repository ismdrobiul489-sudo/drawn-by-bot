// Minimal .env loader (no dependency). Reads <project>/.env once; real
// environment variables win over file values, matching dotenv convention.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let loaded = false;
export function loadEnv() {
  if (loaded) return;
  loaded = true;
  const p = join(ROOT, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

export function env(key, fallback = '') {
  loadEnv();
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

export function envInt(key, fallback) {
  const n = parseInt(env(key, ''), 10);
  return Number.isFinite(n) ? n : fallback;
}
