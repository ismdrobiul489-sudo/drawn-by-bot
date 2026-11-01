// Bengali + Hindi support — no network:
//  - assets/fonts: the four woff2 files exist, are real woff2 (> 20 KB),
//    fonts.css references exactly the files on disk, licenses are present,
//    load-fonts.js knows both families
//  - prep: Devanagari digits verbalize as Hindi words, ASCII digits inside
//    a Hindi sentence too; EN / BN behavior unchanged
//  - listVoices with a MOCK edge-tts: hi-IN voices pass the locale filter,
//    unrelated locales (fr-FR) stay out, and the static fallback has Hindi
import assert from 'node:assert';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FONT_DIR = join(ROOT, 'assets', 'fonts');

// ── fonts on disk ──────────────────────────────────────────────────────────
const EXPECTED_FONTS = [
  'noto-sans-bengali-bengali-400-normal.woff2',
  'noto-sans-bengali-bengali-700-normal.woff2',
  'noto-sans-devanagari-devanagari-400-normal.woff2',
  'noto-sans-devanagari-devanagari-700-normal.woff2',
];
for (const f of EXPECTED_FONTS) {
  const p = join(FONT_DIR, f);
  assert.ok(existsSync(p), `missing font file ${f}`);
  assert.ok(statSync(p).size > 20 * 1024, `${f} is only ${statSync(p).size} bytes`);
  assert.equal(readFileSync(p).subarray(0, 4).toString('ascii'), 'wOF2', `${f} lacks woff2 magic bytes`);
}
const css = readFileSync(join(FONT_DIR, 'fonts.css'), 'utf8');
for (const f of EXPECTED_FONTS) assert.ok(css.includes(f), `fonts.css does not reference ${f}`);
assert.deepEqual(
  readdirSync(FONT_DIR).filter(f => f.endsWith('.woff2')).sort(),
  [...EXPECTED_FONTS].sort(),
  'the woff2 files on disk are exactly the ones fonts.css references');
assert.ok(css.includes("'Noto Sans Bengali'") && css.includes("'Noto Sans Devanagari'"), 'fonts.css family names');
const helper = readFileSync(join(FONT_DIR, 'load-fonts.js'), 'utf8');
assert.ok(helper.includes('Noto Sans Bengali') && helper.includes('Noto Sans Devanagari'), 'load-fonts.js families');
for (const f of EXPECTED_FONTS) assert.ok(helper.includes(f), `load-fonts.js does not name ${f}`);
assert.ok(existsSync(join(FONT_DIR, 'LICENSE-Noto-Sans-Bengali.txt')), 'Bengali OFL text present');
assert.ok(existsSync(join(FONT_DIR, 'LICENSE-Noto-Sans-Devanagari.txt')), 'Devanagari OFL text present');
console.log('  ✓ fonts: 4 woff2 valid (>20KB, wOF2), fonts.css matches disk, licenses + helper present');

// ── prep: Hindi verbalization ──────────────────────────────────────────────
const { verbalizeNumbers } = await import('../media/prep.mjs');
assert.equal(verbalizeNumbers('मुझे ५०० रुपये मिले।'), 'मुझे पाँच सौ रुपये मिले।');
assert.equal(verbalizeNumbers('मुझे 500 रुपये मिले।'), 'मुझे पाँच सौ रुपये मिले।', 'ASCII digits take the Hindi of their sentence');
assert.equal(verbalizeNumbers('छूट १०% मिली।'), 'छूट दस प्रतिशत मिली।');
assert.equal(verbalizeNumbers('कुल ₹1,500 हुए।'), 'कुल एक हज़ार पाँच सौ रुपये हुए।');
assert.equal(verbalizeNumbers('साल 2026 में १,००,००० लोग आए।'), 'साल दो हज़ार छब्बीस में एक लाख लोग आए।', 'lakh grouping');
assert.equal(verbalizeNumbers('रफ़्तार २.५ गुना बढ़ी, दायरा १०-२० दिन।'), 'रफ़्तार दो दशमलव पाँच गुना बढ़ी, दायरा दस से बीस दिन।', 'decimal + range');
// EN / BN untouched, guards intact.
assert.equal(verbalizeNumbers('I earned $500 in 10 days.'), 'I earned five hundred dollars in ten days.');
assert.equal(verbalizeNumbers('আমার কাছে ৫০০ টাকা আছে।'), 'আমার কাছে পাঁচশত টাকা আছে।');
assert.equal(verbalizeNumbers('Ratio 9:16, model gpt-oss-120b, at 10:30.'), 'Ratio 9:16, model gpt-oss-120b, at 10:30.');
console.log('  ✓ prep: Hindi (Devanagari digits, Hindi sentences, lakh/crore), EN/BN unchanged');

// ── listVoices with a mock edge-tts ────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'lang-test-'));
try {
  const mock = join(tmp, 'edge-tts');
  const block = (short, locale, gender) => [
    `Name: Microsoft Server Speech Text to Speech Voice (${locale}, ${short.split('-').pop()})`,
    `ShortName: ${short}`,
    `Locale: ${locale}`,
    `Gender: ${gender}`,
    '',
  ].join('\n');
  writeFileSync(mock, `#!/bin/bash
if [ "$1" = "--list-voices" ]; then
cat <<'EOF'
${block('en-US-AriaNeural', 'en-US', 'Female')}${block('bn-BD-NabanitaNeural', 'bn-BD', 'Female')}${block('hi-IN-SwaraNeural', 'hi-IN', 'Female')}${block('hi-IN-MadhurNeural', 'hi-IN', 'Male')}${block('fr-FR-DeniseNeural', 'fr-FR', 'Female')}EOF
  exit 0
fi
exit 1
`);
  chmodSync(mock, 0o755);
  process.env.EDGE_TTS_BIN = mock;

  const { listVoices, FALLBACK_VOICES } = await import('../media/tts.mjs');
  const { voices, dynamic } = await listVoices();
  assert.equal(dynamic, true, 'mock list is dynamic');
  const shorts = voices.map(v => v.shortName);
  for (const want of ['en-US-AriaNeural', 'bn-BD-NabanitaNeural', 'hi-IN-SwaraNeural', 'hi-IN-MadhurNeural']) {
    assert.ok(shorts.includes(want), `voice list missing ${want}: ${shorts}`);
  }
  assert.ok(!shorts.some(s => s.startsWith('fr-')), `unrelated locale leaked in: ${shorts}`);
  const swara = voices.find(v => v.shortName === 'hi-IN-SwaraNeural');
  assert.equal(swara.locale, 'hi-IN');
  assert.equal(swara.name, 'Swara');
  assert.ok(FALLBACK_VOICES.some(v => v.shortName === 'hi-IN-SwaraNeural'), 'static fallback offers Hindi too');
  console.log('  ✓ tts: listVoices offers en + bn + hi, excludes other locales');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
