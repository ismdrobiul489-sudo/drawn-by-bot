// Delivery encoding: keep Telegram-bound files under TELEGRAM_MAX_MB by
// capping bitrate. The uncapped master always stays in the store.
import { statSync } from 'node:fs';
import { run } from '../lib/run.mjs';

export const MB = 1024 * 1024;

/** Probe duration (s) and size (bytes) of a media file. */
export async function probe(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration,size',
    '-of', 'json', file,
  ]);
  const f = JSON.parse(stdout).format || {};
  return { durationSec: parseFloat(f.duration) || 0, sizeBytes: parseInt(f.size || statSync(file).size, 10) };
}

/**
 * Pure math: video bitrate (bits/s) that fits `durationSec` into
 * `targetBytes`, reserving room for a 128 kbps audio track and 3% mux slack.
 * Returns null when the duration is unknown/zero.
 */
export function videoBitrateForTarget(durationSec, targetBytes, audioBps = 128000) {
  if (!durationSec || durationSec <= 0 || targetBytes <= 0) return null;
  const totalBps = (targetBytes * 8 * 0.97) / durationSec;
  const videoBps = Math.floor(totalBps - audioBps);
  return Math.max(100000, videoBps);
}

/**
 * If `file` already fits maxBytes, returns it unchanged. Otherwise re-encodes
 * to `outFile` with -maxrate/-bufsize set from the computed cap (single pass,
 * predictable size). Returns { file, reencoded, sizeBytes }.
 */
export async function fitForTelegram(file, outFile, maxBytes) {
  const before = await probe(file);
  if (before.sizeBytes <= maxBytes) return { file, reencoded: false, sizeBytes: before.sizeBytes };
  const vBps = videoBitrateForTarget(before.durationSec, maxBytes);
  if (!vBps) throw new Error(`fitForTelegram: cannot probe duration of ${file}`);
  await run('ffmpeg', [
    '-y', '-i', file,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium',
    '-b:v', String(vBps), '-maxrate', String(vBps), '-bufsize', String(vBps * 2),
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outFile,
  ], { timeoutMs: 1000 * 60 * 60 });
  const after = await probe(outFile);
  return { file: outFile, reencoded: true, sizeBytes: after.sizeBytes };
}
