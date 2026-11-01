// Voice-quality layer test — no network, no real keys:
//  - prep: number verbalization (EN + BN), markdown cleanup
//  - plan parsing + sectioned synthesis order, with a MOCK edge-tts binary
//    on PATH (it writes tiny real mp3s via ffmpeg and logs its arguments,
//    so the take-2 --pitch call is asserted)
//  - silencedetect against synthetic ffmpeg audio with a known 2 s gap
//  - word-diff scoring + take-pick logic on fabricated results
//  - qcAudio end-to-end on the mock-made job (silence path only)
import assert from 'node:assert';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Environment BEFORE importing the media modules: mock bin first on PATH,
// TTS_TAKES=2, and no Groq key (the word check must skip/fail soft).
const tmp = mkdtempSync(join(tmpdir(), 'voice-test-'));
const mockBin = join(tmp, 'bin');
mkdirSync(mockBin, { recursive: true });
const mockLog = join(tmp, 'edge-tts-calls.log');
writeFileSync(join(mockBin, 'edge-tts'), `#!/bin/bash
echo "$@" >> "${mockLog}"
out=""; prev=""; list=0
for a in "$@"; do
  if [ "$prev" = "--write-media" ]; then out="$a"; fi
  if [ "$a" = "--list-voices" ]; then list=1; fi
  prev="$a"
done
if [ $list -eq 1 ]; then
  echo "Name: Microsoft Server Speech Text to Speech Voice (en-US, AriaNeural)"
  echo "Locale: en-US"
  echo "Gender: Female"
  exit 0
fi
ffmpeg -y -v error -f lavfi -i anullsrc=r=44100:cl=mono -t 0.3 -codec:a libmp3lame -q:a 9 "$out"
`);
chmodSync(join(mockBin, 'edge-tts'), 0o755);
process.env.PATH = `${mockBin}:${process.env.PATH}`;
process.env.EDGE_TTS_BIN = 'edge-tts';
process.env.TTS_TAKES = '2';
delete process.env.GROQ_API_KEY;

const { verbalizeNumbers, cleanForTTS, prepForTTS } = await import('../media/prep.mjs');
const { parsePlan, synthesizePlan, finalizeTakes } = await import('../media/tts.mjs');
const { detectSilences, wordDiff, pickTake, qcAudio, summarizeQc } = await import('../media/qc-audio.mjs');
const { run } = await import('../lib/run.mjs');
const { probe } = await import('../media/encode.mjs');

try {
  // ── prep: verbalization ──────────────────────────────────────────────────
  assert.equal(verbalizeNumbers('I earned $500 in 10 days.'), 'I earned five hundred dollars in ten days.');
  assert.equal(verbalizeNumbers('Growth was 10% this year.'), 'Growth was ten percent this year.');
  assert.equal(verbalizeNumbers('It runs 2.5x faster.'), 'It runs two point five times faster.');
  assert.equal(verbalizeNumbers('Back in 1999 it cost $5.'), 'Back in nineteen ninety-nine it cost five dollars.');
  assert.equal(verbalizeNumbers('Pi is roughly 3.14.'), 'Pi is roughly three point one four.');
  assert.equal(verbalizeNumbers('About 1,500 people came.'), 'About one thousand five hundred people came.');
  assert.equal(verbalizeNumbers('Only $1 left, 0 errors.'), 'Only one dollar left, zero errors.');
  // Identifiers, ratios, versions and ISO dates are NOT verbalized.
  assert.equal(
    verbalizeNumbers('Ratio 9:16, version 3.14.1, model gpt-oss-120b, date 2026-11-01, at 10:30.'),
    'Ratio 9:16, version 3.14.1, model gpt-oss-120b, date 2026-11-01, at 10:30.');
  // Bengali: native digits, ASCII digits inside a Bengali sentence, taka sign.
  assert.equal(verbalizeNumbers('আমার কাছে ৫০০ টাকা আছে।'), 'আমার কাছে পাঁচশত টাকা আছে।');
  assert.equal(verbalizeNumbers('সে 500 টাকা দিল আর ২৫% ছাড় পেল।'), 'সে পাঁচশত টাকা দিল আর পঁচিশ শতাংশ ছাড় পেল।');
  assert.equal(verbalizeNumbers('দাম ৳১,৫০০ মাত্র।'), 'দাম এক হাজার পাঁচশত টাকা মাত্র।');
  assert.equal(verbalizeNumbers('সময় লাগবে ২.৫ ঘণ্টা।'), 'সময় লাগবে দুই দশমিক পাঁচ ঘণ্টা।');
  console.log('  ✓ prep: verbalizeNumbers (EN money/percent/decimal/year, guards, BN digits + words)');

  // ── prep: cleanup ────────────────────────────────────────────────────────
  const cleaned = cleanForTTS('**Bold** [click here](https://x.com) ![im](a.png) [note] (aside) *em* 🎉 done.');
  assert.ok(!/[*[\]()#]/.test(cleaned), `formatting survived: ${cleaned}`);
  for (const w of ['Bold', 'click here', 'note', 'aside', 'em', 'done']) assert.ok(cleaned.includes(w), `lost word ${w}`);
  assert.equal(prepForTTS('**Pay $500** now!'), 'Pay five hundred dollars now!');
  console.log('  ✓ prep: cleanForTTS strips markdown/brackets/emoji, keeps the words');

  // ── plan parsing ─────────────────────────────────────────────────────────
  assert.throws(() => parsePlan({ sections: [{ name: 'middle', text: 'x' }] }), /must be one of/);
  assert.throws(() => parsePlan({ sections: [] }), /non-empty/);
  assert.throws(() => parsePlan({ sections: [{ name: 'hook', text: '  ' }] }), /empty text/);
  const plan = parsePlan({
    sections: [
      { name: 'hook', text: 'Welcome to the show. Today we earn $500.', tone: 'curious', emphasis: ['five hundred dollars'] },
      { name: 'body', text: 'It grew 10% and runs 2.5x faster.', tone: 'calm', emphasis: [] },
    ],
  });
  assert.deepEqual(plan.map(s => s.name), ['hook', 'body']);
  console.log('  ✓ plan: parsePlan validates names/text, keeps order + tone/emphasis');

  // ── sectioned synthesis with the mock binary ─────────────────────────────
  const jobDir = join(tmp, 'job');
  const r = await synthesizePlan(plan, 'en-US-AriaNeural', jobDir);
  assert.ok(existsSync(r.voicePath), 'voice.mp3 assembled');
  assert.ok((await probe(r.voicePath)).durationSec > 0.5, 'voice.mp3 has real duration');
  const timing = JSON.parse(readFileSync(r.timingPath, 'utf8'));
  assert.equal(timing.plan, true);
  assert.deepEqual(timing.sections.map(s => s.name), ['hook', 'body'], 'sections stay in plan order');
  assert.ok(timing.sections.every(s => s.takes.length === 2 && s.chosen === 1), 'two takes recorded, take 1 chosen by default');
  // Cues are the SPOKEN (prepped) text, in section order.
  assert.ok(timing.cues[0].text.startsWith('Welcome to the show.'), `first cue: ${timing.cues[0].text}`);
  assert.ok(timing.cues.some(c => c.text.includes('five hundred dollars')), 'hook cue is verbalized');
  assert.ok(timing.cues.some(c => c.text.includes('ten percent') && c.text.includes('two point five times')), 'body cue is verbalized');
  assert.ok(timing.cues.every((c, i, a) => i === 0 || c.start >= a[i - 1].start), 'cue offsets increase');
  // The mock saw: 2 chunks (hook text + body text; the splitter groups
  // sentences up to the 1200-char cap) × 2 takes = 4 synth calls, and
  // every take-2 call carried the pitch parameter.
  const calls = readFileSync(mockLog, 'utf8').trim().split('\n').filter(l => l.includes('--write-media'));
  assert.equal(calls.length, 4, `expected 4 synth calls, got ${calls.length}`);
  assert.equal(calls.filter(l => l.includes('--pitch')).length, 2, 'take 2 of each chunk got --pitch');
  assert.ok(calls.every(l => !l.includes('--rate')), 'speed is never touched (stays 100)');
  console.log('  ✓ tts: synthesizePlan — section order, takes, pitch only on take 2, prepped cues');

  // finalizeTakes can re-assemble from take 2.
  const fin = await finalizeTakes(jobDir, { 0: 2 });
  const timing2 = JSON.parse(readFileSync(join(jobDir, 'timing.json'), 'utf8'));
  assert.equal(timing2.sections[0].chosen, 2);
  assert.equal(timing2.sections[1].chosen, 1);
  assert.equal(fin.cues.length, timing.cues.length);
  console.log('  ✓ tts: finalizeTakes re-assembles voice.mp3 from picked takes');

  // ── silence detection on synthetic audio: tone 1s | gap 2s | tone 1s ────
  const wav = join(tmp, 'gap.wav');
  await run('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-filter_complex', '[1:a]atrim=0:2[sil];[0:a][sil][2:a]concat=n=3:v=0:a=1[out]',
    '-map', '[out]', wav]);
  const sils = await detectSilences(wav, 1.2);
  assert.equal(sils.length, 1, `expected exactly 1 flagged silence, got ${JSON.stringify(sils)}`);
  assert.ok(Math.abs(sils[0].start - 1.0) < 0.2 && Math.abs(sils[0].duration - 2.0) < 0.25, `gap at ${sils[0].start}+${sils[0].duration}s`);
  const none = await detectSilences(wav, 3.5);
  assert.equal(none.length, 0, 'a 2s gap is under a 3.5s threshold');
  console.log('  ✓ qc: detectSilences finds the known 2s gap, respects the threshold');

  // ── word diff + take picking (pure) ──────────────────────────────────────
  const same = wordDiff('the quick brown fox', 'the quick brown fox');
  assert.equal(same.score, 1); assert.deepEqual(same.missing, []); assert.deepEqual(same.unexpected, []);
  const diff = wordDiff('the quick brown fox jumps', 'the quick brown fox jumped');
  assert.deepEqual(diff.missing, ['jumps']); assert.deepEqual(diff.unexpected, ['jumped']);
  assert.ok(diff.score > 0.7 && diff.score < 1, `score ${diff.score}`);
  assert.equal(pickTake([{ take: 1, silences: 0, wordScore: 0.90 }, { take: 2, silences: 1, wordScore: 0.99 }]), 2, 'better words beat one gap');
  assert.equal(pickTake([{ take: 1, silences: 2, wordScore: null }, { take: 2, silences: 0, wordScore: null }]), 2, 'silence-only scoring');
  assert.equal(pickTake([{ take: 1, silences: 0, wordScore: 1 }, { take: 2, silences: 0, wordScore: 1 }]), 1, 'tie goes to take 1');
  console.log('  ✓ qc: wordDiff scoring + pickTake (words vs gaps, tie → take 1)');

  // ── qcAudio end-to-end on the mock-made job (silence path) ───────────────
  const job2 = join(tmp, 'job2');
  await synthesizePlan(plan, 'en-US-AriaNeural', job2);
  const qc = await qcAudio(job2, { whisper: false });
  assert.equal(qc.verdict, 'pass', `verdict ${qc.verdict} (${JSON.stringify(qc.notes)})`);
  assert.equal(qc.silences.length, 0, 'mock takes are short — no long gaps');
  assert.equal(qc.wordDiff, null, 'word check off → null diff');
  assert.equal(qc.takes.length, 2);
  assert.ok(qc.takes.every(t => t.chosen === 1), 'equal takes → take 1 kept');
  assert.ok(existsSync(join(job2, 'qc-audio.json')), 'qc-audio.json written');
  assert.equal(summarizeQc(qc), '🎙️ Voice QC: clean (silence check only)');
  assert.equal(summarizeQc({ silences: [{}, {}], wordDiff: { missing: ['a'], unexpected: [] }, sectionsAffected: ['hook'] }),
    '🎙️ Voice QC: 2 long gaps, 1 mismatched word (hook)');
  console.log('  ✓ qc: qcAudio end-to-end (pass, take records, qc-audio.json, Telegram summary)');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
