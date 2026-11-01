// Edge TTS via the `edge-tts` CLI (installed by deploy/setup.sh with pip).
//
// Two entry points:
//   synthesize(text, voice, jobDir)
//     Plain flow: script text → sentence chunks → voice.mp3 + timing.json.
//   synthesizePlan(plan, voice, jobDir)
//     Sectioned flow: the agent's voice-plan.json ({ sections: [{ name:
//     hook|body|outro, text, tone, emphasis }] }) is synthesized section by
//     section and concatenated in plan order. With TTS_TAKES=2 in .env each
//     section also gets a second take at a small pitch offset (a synthesis-
//     time parameter — recorded audio is NEVER stretched or re-pitched
//     afterwards, and speed stays 100; the user's standing rule). The bot's
//     listener QC (media/qc-audio.mjs) scores the takes and calls
//     finalizeTakes() to rebuild voice.mp3 from the winners.
//
// Every text goes through media/prep.mjs first (formatting cleanup +
// numbers written as spoken words); timing.json cues always hold the text
// that was actually spoken. timing.json keeps its legacy shape
// ({ source, cues }) and, for plan jobs, adds `sections` with per-take
// files/cues and the `chosen` take per section — old readers keep working.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { env, envInt } from '../lib/env.mjs';
import { run, binaryExists } from '../lib/run.mjs';
import { probe } from './encode.mjs';
import { prepForTTS, splitSentences } from './prep.mjs';

export { splitSentences }; // shared splitter lives in prep.mjs (re-exported for existing imports)

const TAKE2_PITCH = '+4Hz'; // small, still clearly the same voice

function ttsBin() {
  const bin = env('EDGE_TTS_BIN', 'edge-tts');
  if (!binaryExists(bin)) {
    throw new Error(`Edge TTS binary "${bin}" not found. Install it: pip install edge-tts (deploy/setup.sh does this), or set EDGE_TTS_BIN in .env.`);
  }
  return bin;
}

function takesCount() {
  return Math.min(2, Math.max(1, envInt('TTS_TAKES', 1)));
}

/** Synthesize pre-chunked sentences into part files; returns { parts, cues } with offsets local to the part set. */
async function synthChunks(bin, chunks, voice, jobDir, prefix, pitch) {
  const parts = [];
  const cues = [];
  let cursor = 0;
  for (let i = 0; i < chunks.length; i++) {
    const part = join(jobDir, `${prefix}_${String(i).padStart(3, '0')}.mp3`);
    const args = ['--voice', voice, '--text', chunks[i], '--write-media', part];
    if (pitch) args.push('--pitch', pitch);
    await run(bin, args, { timeoutMs: 1000 * 60 * 5 });
    if (!existsSync(part)) throw new Error(`Edge TTS produced no file for ${prefix} chunk ${i}.`);
    const { durationSec } = await probe(part);
    cues.push({ start: cursor, end: cursor + durationSec, text: chunks[i] });
    cursor += durationSec;
    parts.push(part);
  }
  return { parts, cues };
}

async function concatParts(parts, outFile, jobDir, listName) {
  const listFile = join(jobDir, listName);
  writeFileSync(listFile, parts.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'libmp3lame', '-b:a', '128k', outFile], { timeoutMs: 1000 * 60 * 10 });
}

/**
 * Synthesize `text` in `voice` into jobDir/voice.mp3.
 * Returns { voicePath, timingPath, chunks: [{start, end, text}] }.
 */
export async function synthesize(text, voice, jobDir) {
  const bin = ttsBin();
  mkdirSync(jobDir, { recursive: true });
  const chunks = splitSentences(prepForTTS(text));
  if (!chunks.length) throw new Error('TTS: empty script text.');
  const { parts, cues } = await synthChunks(bin, chunks, voice, jobDir, '_tts', null);
  const voicePath = join(jobDir, 'voice.mp3');
  await concatParts(parts, voicePath, jobDir, '_tts_list.txt');
  const timingPath = join(jobDir, 'timing.json');
  writeFileSync(timingPath, JSON.stringify({ source: 'edge-tts', cues }, null, 2));
  return { voicePath, timingPath, chunks: cues };
}

// ── Voice plans (sectioned multipass) ───────────────────────────────────────

export const SECTION_NAMES = ['hook', 'body', 'outro'];

/**
 * Validate a voice plan (object or JSON string) and normalize it to
 * [{ name, text, tone, emphasis }]. Throws with a clear message on bad input.
 */
export function parsePlan(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const sections = Array.isArray(data) ? data : data?.sections;
  if (!Array.isArray(sections) || !sections.length) {
    throw new Error('voice plan: "sections" must be a non-empty array.');
  }
  return sections.map((s, i) => {
    const name = String(s?.name || '').toLowerCase();
    if (!SECTION_NAMES.includes(name)) {
      throw new Error(`voice plan: section ${i} name must be one of ${SECTION_NAMES.join(' / ')}, got "${s?.name}".`);
    }
    const text = String(s?.text || '').trim();
    if (!text) throw new Error(`voice plan: section "${name}" has empty text.`);
    return {
      name,
      text,
      tone: s?.tone ? String(s.tone) : '',
      emphasis: Array.isArray(s?.emphasis) ? s.emphasis.map(String) : [],
    };
  });
}

/**
 * Synthesize a voice plan into jobDir: one file per section per take
 * (voice_s<i>_<name>_take<t>.mp3), then assemble voice.mp3 from take 1 of
 * each section (qc-audio may later re-assemble via finalizeTakes).
 * Returns { voicePath, timingPath, sections, cues }.
 */
export async function synthesizePlan(rawPlan, voice, jobDir) {
  const bin = ttsBin();
  const plan = parsePlan(rawPlan);
  mkdirSync(jobDir, { recursive: true });
  const takes = takesCount();
  const sections = [];
  for (let si = 0; si < plan.length; si++) {
    const sec = plan[si];
    const chunks = splitSentences(prepForTTS(sec.text));
    if (!chunks.length) throw new Error(`TTS: section "${sec.name}" is empty after prep.`);
    const takeRecs = [];
    for (let take = 1; take <= takes; take++) {
      const pitch = take === 1 ? null : TAKE2_PITCH;
      const { parts, cues } = await synthChunks(bin, chunks, voice, jobDir, `_tts_s${si}_t${take}`, pitch);
      const file = join(jobDir, `voice_s${si}_${sec.name}_take${take}.mp3`);
      await concatParts(parts, file, jobDir, `_tts_s${si}_t${take}_list.txt`);
      takeRecs.push({ take, pitch: pitch || '+0Hz', file: basename(file), cues });
    }
    sections.push({ name: sec.name, tone: sec.tone, emphasis: sec.emphasis, takes: takeRecs, chosen: 1 });
  }
  const timingPath = join(jobDir, 'timing.json');
  writeFileSync(timingPath, JSON.stringify({ source: 'edge-tts', plan: true, sections, cues: [] }, null, 2));
  const fin = await finalizeTakes(jobDir, {});
  return { voicePath: fin.voicePath, timingPath, sections, cues: fin.cues };
}

/**
 * (Re)assemble jobDir/voice.mp3 from the chosen take of each section and
 * rewrite timing.json (top-level cues + section start/end + chosen takes).
 * `picks` maps a section index ("0") or name ("hook") to a take number;
 * sections without a pick keep their recorded choice (default 1).
 */
export async function finalizeTakes(jobDir, picks = {}) {
  const timingPath = join(jobDir, 'timing.json');
  const timing = JSON.parse(readFileSync(timingPath, 'utf8'));
  if (!Array.isArray(timing.sections) || !timing.sections.length) {
    throw new Error('finalizeTakes: timing.json has no sections (not a plan job).');
  }
  const files = [];
  const cues = [];
  let cursor = 0;
  timing.sections.forEach((sec, si) => {
    const want = picks[String(si)] ?? picks[sec.name] ?? sec.chosen ?? 1;
    const rec = sec.takes.find(t => t.take === want) || sec.takes[0];
    sec.chosen = rec.take;
    sec.start = cursor;
    for (const cue of rec.cues) {
      cues.push({ start: cursor + cue.start, end: cursor + cue.end, text: cue.text, section: sec.name });
    }
    // advance the assembly cursor by this take's total duration (its last cue end)
    cursor = sec.start + (rec.cues.length ? rec.cues[rec.cues.length - 1].end : 0);
    sec.end = cursor;
    files.push(join(jobDir, rec.file));
  });
  const voicePath = join(jobDir, 'voice.mp3');
  await concatParts(files, voicePath, jobDir, '_tts_final_list.txt');
  timing.cues = cues;
  writeFileSync(timingPath, JSON.stringify(timing, null, 2));
  return { voicePath, timingPath, cues };
}

// Small static fallback (English + Bengali + Hindi) for when the CLI is not
// installed yet — the bot still shows a usable voice step during setup.
export const FALLBACK_VOICES = [
  { shortName: 'en-US-AriaNeural', name: 'Aria', locale: 'en-US', gender: 'Female' },
  { shortName: 'en-US-JennyNeural', name: 'Jenny', locale: 'en-US', gender: 'Female' },
  { shortName: 'en-US-GuyNeural', name: 'Guy', locale: 'en-US', gender: 'Male' },
  { shortName: 'en-US-EricNeural', name: 'Eric', locale: 'en-US', gender: 'Male' },
  { shortName: 'en-GB-SoniaNeural', name: 'Sonia', locale: 'en-GB', gender: 'Female' },
  { shortName: 'en-GB-RyanNeural', name: 'Ryan', locale: 'en-GB', gender: 'Male' },
  { shortName: 'bn-BD-NabanitaNeural', name: 'Nabanita', locale: 'bn-BD', gender: 'Female' },
  { shortName: 'bn-BD-PradeepNeural', name: 'Pradeep', locale: 'bn-BD', gender: 'Male' },
  { shortName: 'hi-IN-SwaraNeural', name: 'Swara', locale: 'hi-IN', gender: 'Female' },
  { shortName: 'hi-IN-MadhurNeural', name: 'Madhur', locale: 'hi-IN', gender: 'Male' },
];

/** Dynamic voice list from `edge-tts --list-voices`, en-*, bn-* and hi-* only. */
export async function listVoices() {
  const bin = env('EDGE_TTS_BIN', 'edge-tts');
  if (!binaryExists(bin)) return { voices: FALLBACK_VOICES, dynamic: false };
  try {
    const { stdout } = await run(bin, ['--list-voices'], { timeoutMs: 60000 });
    const voices = [];
    let cur = null;
    for (const line of stdout.split(/\r?\n/)) {
      // Newer CLIs print a table whose first column is the ShortName and
      // which has no Locale column — the locale is the ShortName's prefix.
      const row = line.match(/^([a-z]{2}-[A-Z]{2}-\S+?Neural)\s+(Female|Male)\b/);
      if (row) { voices.push({ shortName: row[1], gender: row[2], locale: row[1].slice(0, 5) }); cur = null; continue; }
      const name = line.match(/^Name:\s*(\S+)/);
      if (name) { cur = { shortName: name[1] }; voices.push(cur); continue; }
      if (!cur) continue;
      // The long "Name:" line is prose; the "ShortName:" line that follows
      // it in the key:value format carries the usable --voice value.
      const short = line.match(/^ShortName:\s*(\S+)/); if (short) { cur.shortName = short[1]; continue; }
      const loc = line.match(/Locale:\s*(\S+)/); if (loc) cur.locale = loc[1];
      const gen = line.match(/Gender:\s*(\S+)/); if (gen) cur.gender = gen[1];
    }
    const filtered = voices.filter(v => v.shortName && /^(en|bn|hi)-/.test(v.shortName));
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

// CLI: node media/tts.mjs <script-file> <voice> <job-dir> [--plan <plan.json>] | --list-voices
// With --plan, the plan file's section texts are synthesized; the script
// file argument may be "-" (it is not read in plan mode).
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  (async () => {
    if (argv[0] === '--list-voices') {
      console.log(JSON.stringify(await listVoices()));
      return;
    }
    const flag = argv.indexOf('--plan');
    let planFile = null;
    const pos = [...argv];
    if (flag >= 0) { planFile = argv[flag + 1]; pos.splice(flag, 2); }
    const [scriptFile, voice, dir] = pos;
    if (!voice || !dir || (!planFile && !scriptFile)) {
      console.error('usage: tts.mjs <script-file> <voice> <job-dir> [--plan <plan.json>] | --list-voices');
      process.exit(2);
    }
    const { readFileSync } = await import('node:fs');
    if (planFile) {
      const r = await synthesizePlan(readFileSync(planFile, 'utf8'), voice, dir);
      console.log(JSON.stringify({ ok: true, voicePath: r.voicePath, sections: r.sections.map(s => ({ name: s.name, chosen: s.chosen, takes: s.takes.length })), cues: r.cues.length }));
    } else {
      const r = await synthesize(readFileSync(scriptFile, 'utf8'), voice, dir);
      console.log(JSON.stringify({ ok: true, voicePath: r.voicePath, chunks: r.chunks.length }));
    }
  })().catch(e => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
}
