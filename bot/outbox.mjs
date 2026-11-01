// Outbox: the delivery bridge for the agent's send_file tool.
//
// OpenCode tools run inside the OpenCode server process — they have no
// Telegram token and cannot send anything themselves. Instead the tool
// writes a small JSON request into data/outbox/, and the BOT (which owns
// the token) watches that folder and performs the real send:
//
//   { "path": "core/sandbox/<job>/render/final.mp4", "caption": "…" }
//
// Requests are counted the moment they are first SEEN (arrivedCount) —
// the conversation bridge compares that counter around a turn to catch
// an agent that claims it sent a file but never used the tool. Processed
// requests move to data/outbox/done/ (with the outcome recorded) so a
// restart never re-sends one.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { envInt, ROOT } from '../lib/env.mjs';
import { fitForTelegram, MB } from '../media/encode.mjs';
import { storeFile } from '../media/store.mjs';

const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

export class Outbox {
  /**
   * deps: tg, chatId (the owner's chat — the only place files are sent),
   * dir (default data/outbox), intervalMs (poll cadence).
   */
  constructor({ tg, chatId, dir = join(ROOT, 'data', 'outbox'), intervalMs = 2000 }) {
    if (!tg || !chatId) throw new Error('Outbox needs { tg, chatId }');
    this.tg = tg;
    this.chatId = chatId;
    this.dir = dir;
    this.doneDir = join(dir, 'done');
    this.intervalMs = intervalMs;
    this.seen = new Set();   // request filenames already picked up
    this.arrivedCount = 0;    // requests first seen since process start
    this.onFinalDelivery = null; // wired by bot.mjs → conversation rotation
    this.timer = null;
    this.scanning = false;
    mkdirSync(this.doneDir, { recursive: true });
    // Anything left in done/ from a previous run counts as seen.
    for (const f of readdirSync(this.doneDir)) this.seen.add(f);
  }

  start() {
    if (this.timer) return;
    this.scan().catch(() => {});
    this.timer = setInterval(() => { this.scan().catch(() => {}); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async scan() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      for (const f of readdirSync(this.dir)) {
        if (!f.endsWith('.json') || this.seen.has(f)) continue;
        this.seen.add(f);
        this.arrivedCount += 1;
        await this.process(f).catch(e => console.error('[outbox] process error:', e.message));
      }
    } catch { /* dir briefly unavailable — next tick retries */ }
    finally { this.scanning = false; }
  }

  async process(name) {
    const reqPath = join(this.dir, name);
    let req;
    try { req = JSON.parse(readFileSync(reqPath, 'utf8')); }
    catch { return this.finish(name, { ok: false, error: 'unparseable request JSON' }); }
    const rel = String(req.path || '');
    const abs = resolve(ROOT, rel);
    // Only files inside this repo may be sent.
    if (!rel || !(abs === ROOT || abs.startsWith(ROOT + sep))) {
      return this.finish(name, { ok: false, error: `path outside the project: ${rel}` });
    }
    if (!existsSync(abs)) {
      await this.notifyFailure(basename(rel), 'the file does not exist');
      return this.finish(name, { ok: false, error: 'file does not exist' });
    }
    const caption = String(req.caption || '').slice(0, 1000);
    const ext = extname(abs).toLowerCase();
    try {
      if (VIDEO_EXT.has(ext)) await this.sendVideo(abs, caption);
      else if (IMAGE_EXT.has(ext)) await this.tg.sendPhoto(this.chatId, abs, caption);
      else await this.tg.sendDocument(this.chatId, abs, basename(abs), caption);
      // A FINAL delivery closes the conversation session (owner's
      // lifecycle rule: one session per job). The bridge rotates; the
      // next owner message starts fresh, with memory as continuity.
      if (req.final) { try { await this.onFinalDelivery?.(); } catch (e) { console.error('[outbox] final-delivery hook failed:', e.message); } }
      return this.finish(name, { ok: true, path: rel, ...(req.final ? { final: true } : {}) });
    } catch (e) {
      await this.notifyFailure(basename(rel), e.message);
      return this.finish(name, { ok: false, error: e.message, path: rel });
    }
  }

  async sendVideo(abs, caption) {
    const size = statSync(abs).size;
    const cap = envInt('TELEGRAM_MAX_MB', 48) * MB;
    let fileToSend = abs;
    let note = '';
    if (size > cap) {
      // Over Telegram's bot limit: shrink a delivery copy; keep the
      // master in the store and link it.
      const stored = storeFile('outbox', abs);
      const out = join(this.dir, `.delivery-${Date.now()}.mp4`);
      const fit = await fitForTelegram(abs, out, cap);
      fileToSend = fit.file;
      note = stored.url ? `\n💾 Full-quality backup: ${stored.url}` : '\n(Sent at a reduced size to fit Telegram.)';
    }
    await this.tg.sendVideo(this.chatId, fileToSend, (caption + note).slice(0, 1000));
  }

  /** A failed delivery must be visible in chat, in plain language. */
  async notifyFailure(name, cause) {
    await this.tg.sendMessage(this.chatId, `⚠️ I tried to send ${name} but it failed: ${String(cause).slice(0, 300)}`).catch(() => {});
  }

  finish(name, outcome) {
    try {
      const donePath = join(this.doneDir, name);
      writeFileSync(donePath.replace(/\.json$/, '.result.json'), JSON.stringify({ ...outcome, at: Date.now() }, null, 2));
      renameSync(join(this.dir, name), donePath);
    } catch { /* a lost audit record must not break delivery */ }
  }
}
