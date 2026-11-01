// Automated "listener test" for a finished narration — the pass a human
// would do with headphones, done by machines:
//
//   (a) Silence scan (ffmpeg silencedetect): gaps at or above
//       QC_SILENCE_SEC (default 1.2 s) in the voice are flagged. Normal
//       between-sentence pauses (~0.3 s) stay far below the threshold.
//   (b) Word check (optional, quota-guarded): the voice is re-transcribed
//       with Groq Whisper (media/whisper.mjs) and word-diffed against the
//       exact text that was synthesized (the timing.json cues). Skipped
//       when the total audio — every take counts — exceeds
//       QC_WHISPER_MAX_SEC (default 1200 s), so a long video can never
//       burn the user's Groq free quota on QC. The skip is recorded.
//   (c) Take picking: when the TTS ran with TTS_TAKES=2, each section's
//       takes are scored (silence flags + word match) and voice.mp3 is
//       re-assembled from the winners via tts.finalizeTakes().
//
// The verdict is advisory like the vision QC: pass | warn | fail, written
// to <jobDir>/qc-audio.json. The processor surfaces a one-line summary in
// Telegram and, on "fail", asks the agent to regenerate only the flagged
// sections. QC never throws on a missing key or a failed Whisper call —
// those become notes with wordDiff = null.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env, envInt } from '../lib/env.mjs';
import { run } from '../lib/run.mjs';
import { probe } from './encode.mjs';
import { transcribeToSrt } from './whisper.mjs';
import { finalizeTakes } from './tts.mjs';
import { verbalizeNumbers } from './prep.mjs';

const FAIL_SILENCE_SEC = 3.0;   // a single gap this long is a defect, not a pause
const FAIL_WORD_SCORE = 0.90;   // below this the narration likely says other words
const WARN_WORD_SCORE = 0.98;

// ── Silence detection ───────────────────────────────────────────────────────

/**
 * Silences in `file` lasting at least `minSec` seconds, as
 * [{ start, end, duration }] (seconds, 2-dp). Parses ffmpeg's
 * silencedetect log from stderr.
 */
export async function detectSilences(file, minSec) {
  const { stderr } = await run('ffmpeg', [
    '-i', file, '-af', `silencedetect=noise=-45dB:d=${minSec}`, '-f', 'null', '-',
  ], { timeoutMs: 1000 * 60 * 10 });
  const starts = [...stderr.matchAll(/silence_start:\s*([\d.]+)/g)].map(m => parseFloat(m[1]));
  const ends = [...stderr.matchAll(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g)]
    .map(m => ({ end: parseFloat(m[1]), duration: parseFloat(m[2]) }));
  const out = [];
  for (let i = 0; i < starts.length; i++) {
    if (ends[i]) {
      out.push({ start: round2(starts[i]), end: round2(ends[i].end), duration: round2(ends[i].duration) });
    } else {
      // Trailing silence with no end event: close it at the file's duration.
      const { durationSec } = await probe(file);
      out.push({ start: round2(starts[i]), end: round2(durationSec), duration: round2(durationSec - starts[i]) });
    }
  }
  return out.filter(s => s.duration >= minSec - 0.05);
}

const round2 = n => Math.round(n * 100) / 100;

// ── Word diff ───────────────────────────────────────────────────────────────

export function wordTokens(text) {
  return String(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
}

/**
 * Multiset word diff between the script text and what was heard.
 * Returns { missing, unexpected, score, matched, scriptWords, heardWords }
 * where score = matched / max(scriptWords, heardWords) in [0, 1].
 */
export function wordDiff(scriptText, heardText) {
  const a = wordTokens(scriptText);
  const b = wordTokens(heardText);
  const count = arr => arr.reduce((m, w) => m.set(w, (m.get(w) || 0) + 1), new Map());
  const ca = count(a), cb = count(b);
  const missing = [], unexpected = [];
  let matched = 0;
  for (const [w, n] of ca) {
    const m = Math.min(n, cb.get(w) || 0);
    matched += m;
    for (let i = m; i < n; i++) missing.push(w);
  }
  for (const [w, n] of cb) {
    const extra = n - (ca.get(w) || 0);
    for (let i = 0; i < extra; i++) unexpected.push(w);
  }
  const denom = Math.max(a.length, b.length, 1);
  return { missing, unexpected, score: matched / denom, matched, scriptWords: a.length, heardWords: b.length };
}

// ── Take scoring ────────────────────────────────────────────────────────────

/** Penalty for one take: silence flags weigh 0.05 each, word mismatch weighs its full miss rate. Lower wins. */
export function scoreTake({ silences = 0, wordScore = null } = {}) {
  return silences * 0.05 + (wordScore == null ? 0 : 1 - wordScore);
}

/** Pick the winning take number from [{ take, silences, wordScore }]; ties go to the lowest take number (take 1 first). */
export function pickTake(takes) {
  return takes.slice().sort((x, y) => scoreTake(x) - scoreTake(y) || x.take - y.take)[0].take;
}

// ── Main QC ─────────────────────────────────────────────────────────────────

function verdictFor({ silences, wordDiff: wd }) {
  if (silences.some(s => s.duration >= FAIL_SILENCE_SEC)) return 'fail';
  if (wd && wd.score < FAIL_WORD_SCORE) return 'fail';
  if (silences.length) return 'warn';
  if (wd && wd.score < WARN_WORD_SCORE) return 'warn';
  return 'pass';
}

/**
 * Run the listener test on jobDir/voice.mp3. Writes qc-audio.json and
 * returns the result object. `opts.scriptFile` is the fallback spoken-text
 * source for non-plan jobs (timing.json cues win when present);
 * `opts.whisper=false` forces the silence-only path (tests, quota care).
 */
export async function qcAudio(jobDir, { scriptFile, whisper = true } = {}) {
  const silenceSec = parseFloat(env('QC_SILENCE_SEC', '1.2')) || 1.2;
  const whisperMaxSec = envInt('QC_WHISPER_MAX_SEC', 1200);
  const voicePath = join(jobDir, 'voice.mp3');
  if (!existsSync(voicePath)) throw new Error('qc-audio: voice.mp3 not found in the job folder.');
  const timingPath = join(jobDir, 'timing.json');
  const timing = existsSync(timingPath) ? JSON.parse(readFileSync(timingPath, 'utf8')) : null;

  const notes = [];
  const result = {
    voice: 'voice.mp3',
    silenceThresholdSec: silenceSec,
    silences: [],
    wordDiff: null,
    sectionsAffected: [],
    verdict: 'pass',
    notes,
  };

  async function whisperText(audioFile, tag) {
    const r = await transcribeToSrt(audioFile, join(jobDir, '_qc', tag));
    return readFileSync(r.transcriptPath, 'utf8');
  }

  if (timing?.sections?.length) {
    // ── Plan job: score every take per section, pick winners ──
    const takeDurTotal = timing.sections.reduce(
      (sum, sec) => sum + sec.takes.reduce((s, t) => s + (t.cues.length ? t.cues[t.cues.length - 1].end : 0), 0), 0);
    let doWhisper = whisper;
    if (whisper && takeDurTotal > whisperMaxSec) {
      doWhisper = false;
      notes.push(`Word check skipped: ${Math.round(takeDurTotal)}s of takes exceeds QC_WHISPER_MAX_SEC (${whisperMaxSec}s). Silence check only.`);
    }
    const picks = {};
    const chosenDiffs = [];
    result.takes = [];
    for (let si = 0; si < timing.sections.length; si++) {
      const sec = timing.sections[si];
      const takeResults = [];
      for (const rec of sec.takes) {
        const file = join(jobDir, rec.file);
        const sils = await detectSilences(file, silenceSec);
        let diff = null, wordScore = null;
        if (doWhisper) {
          try {
            const heard = await whisperText(file, `s${si}_t${rec.take}`);
            diff = wordDiff(rec.cues.map(c => c.text).join(' '), verbalizeNumbers(heard));
            wordScore = diff.score;
          } catch (e) {
            notes.push(`Word check failed for section "${sec.name}" take ${rec.take}: ${e.message}`);
          }
        }
        takeResults.push({ take: rec.take, silences: sils, wordScore, diff });
      }
      const chosen = pickTake(takeResults.map(t => ({ take: t.take, silences: t.silences.length, wordScore: t.wordScore })));
      picks[String(si)] = chosen;
      const chosenRec = takeResults.find(t => t.take === chosen);
      result.takes.push({ section: sec.name, chosen, takes: takeResults.map(({ take, silences, wordScore }) => ({ take, silenceFlags: silences.length, wordScore })) });
      if (chosenRec.diff) chosenDiffs.push(chosenRec.diff);
      const secAffected = chosenRec.silences.length > 0
        || (chosenRec.diff && (chosenRec.diff.missing.length + chosenRec.diff.unexpected.length) > 0);
      if (secAffected) result.sectionsAffected.push(sec.name);
      sec._chosenSilences = chosenRec.silences; // stashed, removed before write
    }
    // Re-assemble if any winner differs from the recorded choice.
    const changed = timing.sections.some((sec, si) => (sec.chosen ?? 1) !== picks[String(si)]);
    if (changed) await finalizeTakes(jobDir, picks);
    const fresh = JSON.parse(readFileSync(timingPath, 'utf8'));
    fresh.sections.forEach((sec, si) => {
      for (const s of timing.sections[si]._chosenSilences || []) {
        result.silences.push({ start: round2(sec.start + s.start), end: round2(sec.start + s.end), duration: s.duration, section: sec.name });
      }
      delete timing.sections[si]._chosenSilences;
    });
    if (chosenDiffs.length) {
      const matched = chosenDiffs.reduce((s, d) => s + d.matched, 0);
      const denom = Math.max(
        chosenDiffs.reduce((s, d) => s + d.scriptWords, 0),
        chosenDiffs.reduce((s, d) => s + d.heardWords, 0), 1);
      result.wordDiff = {
        missing: chosenDiffs.flatMap(d => d.missing),
        unexpected: chosenDiffs.flatMap(d => d.unexpected),
        score: matched / denom,
      };
    }
  } else {
    // ── Legacy job (no plan): check voice.mp3 as a whole ──
    result.silences = await detectSilences(voicePath, silenceSec);
    const { durationSec } = await probe(voicePath);
    if (whisper && durationSec > whisperMaxSec) {
      notes.push(`Word check skipped: voice is ${Math.round(durationSec)}s, over QC_WHISPER_MAX_SEC (${whisperMaxSec}s). Silence check only.`);
    } else if (whisper) {
      try {
        const heard = await whisperText(voicePath, 'main');
        const spoken = timing?.cues?.length
          ? timing.cues.map(c => c.text).join(' ')
          : (scriptFile && existsSync(scriptFile) ? readFileSync(scriptFile, 'utf8') : '');
        if (spoken) {
          const d = wordDiff(spoken, verbalizeNumbers(heard));
          result.wordDiff = { missing: d.missing, unexpected: d.unexpected, score: d.score };
        } else {
          notes.push('Word check skipped: no script/timing text to diff against.');
        }
      } catch (e) {
        notes.push(`Word check failed: ${e.message}`);
      }
    }
  }

  result.verdict = verdictFor(result);
  result.qcPath = join(jobDir, 'qc-audio.json');
  writeFileSync(result.qcPath, JSON.stringify(result, null, 2));
  return result;
}

/** One-line English summary for the Telegram preview, e.g. "🎙️ Voice QC: clean". */
export function summarizeQc(qc) {
  if (!qc) return null;
  const gaps = qc.silences?.length || 0;
  const mism = qc.wordDiff ? qc.wordDiff.missing.length + qc.wordDiff.unexpected.length : 0;
  if (!gaps && !mism) {
    return qc.wordDiff ? '🎙️ Voice QC: clean' : '🎙️ Voice QC: clean (silence check only)';
  }
  const parts = [];
  if (gaps) parts.push(`${gaps} long gap${gaps > 1 ? 's' : ''}`);
  if (mism) parts.push(`${mism} mismatched word${mism > 1 ? 's' : ''}`);
  const secs = qc.sectionsAffected?.length ? ` (${qc.sectionsAffected.join(', ')})` : '';
  return `🎙️ Voice QC: ${parts.join(', ')}${secs}`;
}

// CLI: node media/qc-audio.mjs <job-dir>
if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir] = process.argv.slice(2);
  if (!dir) { console.error('usage: qc-audio.mjs <job-dir>'); process.exit(2); }
  qcAudio(dir)
    .then(r => console.log(JSON.stringify({ ok: true, verdict: r.verdict, silences: r.silences.length, wordDiff: r.wordDiff, qcPath: r.qcPath })))
    .catch(e => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
}
