// File store: every finished master is copied to store/<jobId>/ and gets an
// unguessable token URL (PUBLIC_BASE_URL/files/<token>/<file>) served by the
// tiny HTTP server started in the bot process. This is the backup link that
// travels with the Telegram message, and the only delivery when a video is
// too large for Telegram even after bitrate capping.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { env, envInt, ROOT } from '../lib/env.mjs';

const STORE_DIR = join(ROOT, 'store');
const INDEX_FILE = join(STORE_DIR, 'index.json');

function loadIndex() {
  try { return JSON.parse(readFileSync(INDEX_FILE, 'utf8')); } catch { return {}; }
}
function saveIndex(idx) {
  mkdirSync(STORE_DIR, { recursive: true });
  writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2));
}

/** Copy a master file into the store; returns { token, url, storedPath }. */
export function storeFile(jobId, filePath) {
  const dir = join(STORE_DIR, jobId);
  mkdirSync(dir, { recursive: true });
  const name = basename(filePath);
  const storedPath = join(dir, name);
  copyFileSync(filePath, storedPath);
  const idx = loadIndex();
  const token = idx[jobId]?.token || randomBytes(12).toString('hex');
  idx[jobId] = { token, file: name, createdAt: Date.now() };
  saveIndex(idx);
  const base = env('PUBLIC_BASE_URL').replace(/\/$/, '');
  return { token, storedPath, url: base ? `${base}/files/${token}/${encodeURIComponent(name)}` : null };
}

const MIME = { '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.srt': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png' };

/** Start the store HTTP server (also answers /health). Returns the server. */
export function startStoreServer() {
  const port = envInt('STORE_PORT', 8090);
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
    const m = url.pathname.match(/^\/files\/([a-f0-9]+)\/(.+)$/);
    if (!m) { res.writeHead(404); res.end('not found'); return; }
    const [, token, rawName] = m;
    const idx = loadIndex();
    const jobId = Object.keys(idx).find(k => idx[k].token === token);
    const name = decodeURIComponent(rawName);
    if (!jobId || idx[jobId].file !== name || name.includes('..')) { res.writeHead(404); res.end('not found'); return; }
    const file = join(STORE_DIR, jobId, name);
    if (!existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[extname(name).toLowerCase()] || 'application/octet-stream', 'Content-Length': statSync(file).size });
    import('node:fs').then(fs => fs.createReadStream(file).pipe(res));
  });
  server.listen(port, () => console.log(`[store] serving on :${port}`));
  return server;
}

/** Delete stored jobs older than STORE_KEEP_DAYS. Returns count removed. */
export function rotateStore() {
  const keepMs = envInt('STORE_KEEP_DAYS', 30) * 86400000;
  const idx = loadIndex();
  let removed = 0;
  for (const [jobId, rec] of Object.entries(idx)) {
    if (Date.now() - (rec.createdAt || 0) > keepMs) {
      rmSync(join(STORE_DIR, jobId), { recursive: true, force: true });
      delete idx[jobId];
      removed++;
    }
  }
  if (removed) saveIndex(idx);
  return removed;
}
