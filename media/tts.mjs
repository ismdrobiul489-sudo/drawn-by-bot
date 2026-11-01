// Edge TTS via the `edge-tts` CLI (installed by deploy/setup.sh with pip).
// Script text → sentence-sized chunks → one mp3 per chunk (synthesis at
// speed 100 — the user's standing rule: never time-stretch TTS) → ffmpeg
// concat → voice.mp3, plus timing.json with per-chunk start offsets measured
// from the real audio durations.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../lib/env.mjs';
import { run, binaryExists } from '../lib/run.mjs';
import { probe } from './encode.mjs';

const MAX_CHARS = 1200; // edge-tts handles long text, but smaller chunks fail softer

/** Split text into sentence-ish chunks of at most maxChars characters. */
export function splitSentences(text, maxChars = MAX_CHARS) {
  const parts = String(text).replace(/\s+/g, ' ').trim().match(/[^.!?…]+[.!?…]*\s*/g) || [String(text).trim()];
  const chunks = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length > maxChars && cur) { chunks.push(cur.trim()); cur = p; }
    else cur += p;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.filter(Boolean);
}

function ttsBin() {
  const bin = env('EDGE_TTS_BIN', 'edge-tts');
  if (!binaryExists(bin)) {
    throw new Error(`Edge TTS binary "${bin}" not found. Install it: pip install edge-tts (deploy/setup.sh does this), or set EDGE_TTS_BIN in .env.`);
  }
  return bin;
}

/**
 * Synthesize `text` in `voice` into jobDir/voice.mp3.
 * Returns { voicePath, timingPath, chunks: [{start, end, text}] }.
 */
export async function synthesize(text, voice, jobDir) {
  const bin = ttsBin();
  mkdirSync(jobDir, { recursive: true });
  const chunks = splitSentences(text);
  if (!chunks.length) throw new Error('TTS: empty script text.');
  const parts = [];
  const cues = [];
  let cursor = 0;
  for (let i = 0; i < chunks.length; i++) {
    const part = join(jobDir, `_tts_${String(i).padStart(3, '0')}.mp3`);
    await run(bin, ['--voice', voice, '--text', chunks[i], '--write-media', part], { timeoutMs: 1000 * 60 * 5 });
    if (!existsSync(part)) throw new Error(`Edge TTS produced no file for chunk ${i}.`);
    const { durationSec } = await probe(part);
    cues.push({ start: cursor, end: cursor + durationSec, text: chunks[i] });
    cursor += durationSec;
    parts.push(part);
  }
  const listFile = join(jobDir, '_tts_list.txt');
  writeFileSync(listFile, parts.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  const voicePath = join(jobDir, 'voice.mp3');
  await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'libmp3lame', '-b:a', '128k', voicePath], { timeoutMs: 1000 * 60 * 10 });
  const timingPath = join(jobDir, 'timing.json');
  writeFileSync(timingPath, JSON.stringify({ source: 'edge-tts', cues }, null, 2));
  return { voicePath, timingPath, chunks: cues };
}

// Small static fallback (English + Bengali) for when the CLI is not installed
// yet — the bot still shows a usable voice step during setup.
export const FALLBACK_VOICES = [
  { shortName: 'en-US-AriaNeural', name: 'Aria', locale: 'en-US', gender: 'Female' },
  { shortName: 'en-US-JennyNeural', name: 'Jenny', locale: 'en-US', gender: 'Female' },
  { shortName: 'en-US-GuyNeural', name: 'Guy', locale: 'en-US', gender: 'Male' },
  { shortName: 'en-US-EricNeural', name: 'Eric', locale: 'en-US', gender: 'Male' },
  { shortName: 'en-GB-SoniaNeural', name: 'Sonia', locale: 'en-GB', gender: 'Female' },
  { shortName: 'en-GB-RyanNeural', name: 'Ryan', locale: 'en-GB', gender: 'Male' },
  { shortName: 'bn-BD-NabanitaNeural', name: 'Nabanita', locale: 'bn-BD', gender: 'Female' },
  { shortName: 'bn-BD-PradeepNeural', name: 'Pradeep', locale: 'bn-BD', gender: 'Male' },
];

/** Dynamic voice list from `edge-tts --list-voices`, en-* and bn-* only. */
export async function listVoices() {
  const bin = env('EDGE_TTS_BIN', 'edge-tts');
  if (!binaryExists(bin)) return { voices: FALLBACK_VOICES, dynamic: false };
  try {
    const { stdout } = await run(bin, ['--list-voices'], { timeoutMs: 60000 });
    const voices = [];
    let cur = null;
    for (const line of stdout.split(/\r?\n/)) {
      const name = line.match(/^Name:\s*(\S+)/);
      if (name) { cur = { shortName: name[1] }; voices.push(cur); continue; }
      if (!cur) continue;
      const loc = line.match(/Locale:\s*(\S+)/); if (loc) cur.locale = loc[1];
      const gen = line.match(/Gender:\s*(\S+)/); if (gen) cur.gender = gen[1];
    }
    const filtered = voices.filter(v => v.shortName && /^(en|bn)-/.test(v.shortName));
    // Friendly display name = the persona part of "en-US-AriaNeural" → "Aria".
    for (const v of filtered) v.name = (v.shortName.split('-').pop() || v.shortName).replace(/Neural$/, '');
    // The CLI's "Name:" is the long id (Microsoft Server Speech ... en-US-AriaNeural);
    // the usable --voice value is that trailing token. Keep the tail token.
    for (const v of filtered) {
      const m = v.shortName.match(/([a-z]{2}-[A-Z]{2}-\S+Neural)$/);
      if (m) v.shortName = m[1];
    }
    const usable = filtered.filter(v => /^[a-z]{2}-[A-Z]{2}-/.test(v.shortName));
    return { voices: usable.length ? usable : FALLBACK_VOICES, dynamic: usable.length > 0 };
  } catch {
    return { voices: FALLBACK_VOICES, dynamic: false };
  }
}

// CLI: node media/tts.mjs <script-file> <voice> <job-dir> | --list-voices
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  (async () => {
    if (args[0] === '--list-voices') {
      console.log(JSON.stringify(await listVoices()));
    } else {
      const [scriptFile, voice, dir] = args;
      if (!scriptFile || !voice || !dir) { console.error('usage: tts.mjs <script-file> <voice> <job-dir> | --list-voices'); process.exit(2); }
      const { readFileSync } = await import('node:fs');
      const r = await synthesize(readFileSync(scriptFile, 'utf8'), voice, dir);
      console.log(JSON.stringify({ ok: true, voicePath: r.voicePath, chunks: r.chunks.length }));
    }
  })().catch(e => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
}
