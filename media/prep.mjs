// Script prep for speech — our own deterministic cleanup stage that runs
// before any TTS synthesis. Two jobs, both meaning-preserving:
//   cleanForTTS      — strip formatting a speech engine would trip over
//                      (markdown, links, brackets, emoji, stray symbols).
//   verbalizeNumbers — write numbers the way they are spoken (amounts,
//                      percents, decimals, ranges, years), in English for
//                      English text, Bengali for Bengali text and Hindi
//                      for Hindi (Devanagari) text.
// splitSentences also lives here: it is shared by tts.mjs (chunking) and
// anything else that needs sentence boundaries.

// ── English number words ────────────────────────────────────────────────────

const EN_ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function enInt(n) {
  if (n < 20) return EN_ONES[n];
  if (n < 100) { const r = n % 10; return EN_TENS[Math.floor(n / 10)] + (r ? '-' + EN_ONES[r] : ''); }
  if (n < 1000) { const r = n % 100; return EN_ONES[Math.floor(n / 100)] + ' hundred' + (r ? ' ' + enInt(r) : ''); }
  for (const [v, name] of [[1e12, 'trillion'], [1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']]) {
    if (n >= v) { const r = n % v; return enInt(Math.floor(n / v)) + ' ' + name + (r ? ' ' + enInt(r) : ''); }
  }
  return String(n);
}

/** 1999 → "nineteen ninety-nine", 2026 → "twenty twenty-six", 1900 → "nineteen hundred". */
function enYear(n) {
  if (n === 2000) return 'two thousand';
  const hi = Math.floor(n / 100), lo = n % 100;
  if (lo === 0) return enInt(hi) + ' hundred';
  return enInt(hi) + ' ' + (lo < 10 ? 'oh ' + EN_ONES[lo] : enInt(lo));
}

// ── Bengali number words ────────────────────────────────────────────────────
// Bengali cardinals are irregular up to 99, so they are tabled in full;
// above that the system is lakh (১ লাখ = 1e5) and crore (১ কোটি = 1e7).

const BN_WORDS = [
  'শূন্য', 'এক', 'দুই', 'তিন', 'চার', 'পাঁচ', 'ছয়', 'সাত', 'আট', 'নয়',
  'দশ', 'এগারো', 'বারো', 'তেরো', 'চৌদ্দ', 'পনেরো', 'ষোলো', 'সতেরো', 'আঠারো', 'উনিশ',
  'বিশ', 'একুশ', 'বাইশ', 'তেইশ', 'চব্বিশ', 'পঁচিশ', 'ছাব্বিশ', 'সাতাশ', 'আঠাশ', 'ঊনত্রিশ',
  'ত্রিশ', 'একত্রিশ', 'বত্রিশ', 'তেত্রিশ', 'চৌত্রিশ', 'পঁয়ত্রিশ', 'ছত্রিশ', 'সাঁইত্রিশ', 'আটত্রিশ', 'ঊনচল্লিশ',
  'চল্লিশ', 'একচল্লিশ', 'বিয়াল্লিশ', 'তেতাল্লিশ', 'চুয়াল্লিশ', 'পঁয়তাল্লিশ', 'ছেচল্লিশ', 'সাতচল্লিশ', 'আটচল্লিশ', 'ঊনপঞ্চাশ',
  'পঞ্চাশ', 'একান্ন', 'বাহান্ন', 'তিপ্পান্ন', 'চুয়ান্ন', 'পঞ্চান্ন', 'ছাপ্পান্ন', 'সাতান্ন', 'আটান্ন', 'ঊনষাট',
  'ষাট', 'একষট্টি', 'বাষট্টি', 'তেষট্টি', 'চৌষট্টি', 'পঁয়ষট্টি', 'ছেষট্টি', 'সাতষট্টি', 'আটষট্টি', 'ঊনসত্তর',
  'সত্তর', 'একাত্তর', 'বাহাত্তর', 'তিয়াত্তর', 'চুয়াত্তর', 'পঁচাত্তর', 'ছিয়াত্তর', 'সাতাত্তর', 'আটাত্তর', 'ঊনআশি',
  'আশি', 'একাশি', 'বিরাশি', 'তিরাশি', 'চুরাশি', 'পঁচাশি', 'ছিয়াশি', 'সাতাশি', 'আটাশি', 'ঊননব্বই',
  'নব্বই', 'একানব্বই', 'বিরানব্বই', 'তিরানব্বই', 'চুরানব্বই', 'পঁচানব্বই', 'ছিয়ানব্বই', 'সাতানব্বই', 'আটানব্বই', 'নিরানব্বই',
];

function bnInt(n) {
  if (n < 100) return BN_WORDS[n];
  const parts = [];
  const crore = Math.floor(n / 1e7), lakh = Math.floor((n % 1e7) / 1e5);
  const thousand = Math.floor((n % 1e5) / 1000), hundred = Math.floor((n % 1000) / 100), rest = n % 100;
  if (crore) parts.push(bnInt(crore) + ' কোটি');
  if (lakh) parts.push(BN_WORDS[lakh] + ' লক্ষ');
  if (thousand) parts.push(BN_WORDS[thousand] + ' হাজার');
  if (hundred) parts.push(BN_WORDS[hundred] + 'শত');
  if (rest) parts.push(BN_WORDS[rest]);
  return parts.join(' ');
}

const BN_DIGIT_CHARS = '০১২৩৪৫৬৭৮৯';

// ── Hindi number words ──────────────────────────────────────────────────────
// Hindi cardinals are irregular up to 99, tabled in full like the Bengali
// ones; above that the same lakh (१ लाख = 1e5) and crore (१ करोड़ = 1e7)
// grouping is used.

const HI_WORDS = [
  'शून्य', 'एक', 'दो', 'तीन', 'चार', 'पाँच', 'छह', 'सात', 'आठ', 'नौ',
  'दस', 'ग्यारह', 'बारह', 'तेरह', 'चौदह', 'पंद्रह', 'सोलह', 'सत्रह', 'अठारह', 'उन्नीस',
  'बीस', 'इक्कीस', 'बाईस', 'तेईस', 'चौबीस', 'पच्चीस', 'छब्बीस', 'सत्ताईस', 'अट्ठाईस', 'उनतीस',
  'तीस', 'इकतीस', 'बत्तीस', 'तैंतीस', 'चौंतीस', 'पैंतीस', 'छत्तीस', 'सैंतीस', 'अड़तीस', 'उनतालीस',
  'चालीस', 'इकतालीस', 'बयालीस', 'तैंतालीस', 'चवालीस', 'पैंतालीस', 'छियालीस', 'सैंतालीस', 'अड़तालीस', 'उनचास',
  'पचास', 'इक्यावन', 'बावन', 'तिरपन', 'चौवन', 'पचपन', 'छप्पन', 'सत्तावन', 'अट्ठावन', 'उनसठ',
  'साठ', 'इकसठ', 'बासठ', 'तिरसठ', 'चौंसठ', 'पैंसठ', 'छियासठ', 'सड़सठ', 'अड़सठ', 'उनहत्तर',
  'सत्तर', 'इकहत्तर', 'बहत्तर', 'तिहत्तर', 'चौहत्तर', 'पचहत्तर', 'छिहत्तर', 'सतहत्तर', 'अठहत्तर', 'उनासी',
  'अस्सी', 'इक्यासी', 'बयासी', 'तिरासी', 'चौरासी', 'पचासी', 'छियासी', 'सत्तासी', 'अट्ठासी', 'नवासी',
  'नब्बे', 'इक्यानवे', 'बानवे', 'तिरानवे', 'चौरानवे', 'पचानवे', 'छियानवे', 'सत्तानवे', 'अट्ठानवे', 'निन्यानवे',
];

function hiInt(n) {
  if (n < 100) return HI_WORDS[n];
  const parts = [];
  const crore = Math.floor(n / 1e7), lakh = Math.floor((n % 1e7) / 1e5);
  const thousand = Math.floor((n % 1e5) / 1000), hundred = Math.floor((n % 1000) / 100), rest = n % 100;
  if (crore) parts.push(hiInt(crore) + ' करोड़');
  if (lakh) parts.push(HI_WORDS[lakh] + ' लाख');
  if (thousand) parts.push(HI_WORDS[thousand] + ' हज़ार');
  if (hundred) parts.push(HI_WORDS[hundred] + ' सौ');
  if (rest) parts.push(HI_WORDS[rest]);
  return parts.join(' ');
}

const DV_DIGIT_CHARS = '०१२३४५६७८९';
const toAsciiDigits = s => s
  .replace(/[০-৯]/g, d => BN_DIGIT_CHARS.indexOf(d))
  .replace(/[०-९]/g, d => DV_DIGIT_CHARS.indexOf(d));

// ── Shared token machinery ──────────────────────────────────────────────────

const CURRENCIES = {
  '$': { en: ['dollar', 'dollars'], bn: 'ডলার', hi: ['डॉलर', 'डॉलर'] },
  '€': { en: ['euro', 'euros'], bn: 'ইউরো', hi: ['यूरो', 'यूरो'] },
  '£': { en: ['pound', 'pounds'], bn: 'পাউন্ড', hi: ['पाउंड', 'पाउंड'] },
  '₹': { en: ['rupee', 'rupees'], bn: 'রুপি', hi: ['रुपया', 'रुपये'] },
  '৳': { en: ['taka', 'taka'], bn: 'টাকা', hi: ['टाका', 'टाका'] },
};

// Spoken joiners per language (leading/trailing spaces included).
const SPOKEN = {
  en: { point: ' point ', percent: ' percent', times: ' times', range: ' to ' },
  bn: { point: ' দশমিক ', percent: ' শতাংশ', times: ' গুণ', range: ' থেকে ' },
  hi: { point: ' दशमलव ', percent: ' प्रतिशत', times: ' गुना', range: ' से ' },
};

const DIGITS = String.raw`\d[\d,]*|[০-৯][০-৯,]*|[०-९][०-९,]*`;
const NUM = String.raw`(?:${DIGITS})(?:\.(?:\d+|[০-৯]+|[०-९]+))?`;
const RANGE_RE = new RegExp(String.raw`(?:([$€£₹৳])[ ]?)?(${NUM})\s*[-–—]\s*(${NUM})(\s?%|[xX×](?!\p{L}))?`, 'gu');
const SINGLE_RE = new RegExp(String.raw`(?:([$€£₹৳])[ ]?)?(${NUM})(\s?%|[xX×](?!\p{L}))?`, 'gu');

/** Sentence spans [start, end) — used only to pick a number's language. */
function sentenceSpans(text) {
  const spans = [];
  let start = 0;
  const re = /[.!?…।\n]/g;
  let m;
  while ((m = re.exec(text))) { spans.push([start, m.index + 1]); start = m.index + 1; }
  if (start < text.length) spans.push([start, text.length]);
  return spans;
}

/** Bengali digits are always spoken in Bengali and Devanagari digits in
 *  Hindi; ASCII digits take the language of the sentence they sit in.
 *  Bengali is checked before Devanagari because the Bengali sentence
 *  mark '।' (U+0964) itself sits inside the Devanagari block. */
function langAt(text, spans, idx, rawToken) {
  if (/[০-৯]/.test(rawToken)) return 'bn';
  if (/[०-९]/.test(rawToken)) return 'hi';
  const span = spans.find(([a, b]) => idx >= a && idx < b) || [0, text.length];
  const s = text.slice(span[0], span[1]);
  if (/[\u0980-\u09FF]/.test(s)) return 'bn';
  if (/[\u0900-\u097F]/.test(s)) return 'hi';
  return 'en';
}

function intWords(intVal, lang) { return lang === 'bn' ? bnInt(intVal) : lang === 'hi' ? hiInt(intVal) : enInt(intVal); }

function numberWords(numRaw, lang, { currency = null, suffix = null, allowYear = true } = {}) {
  const ascii = toAsciiDigits(numRaw).replace(/,/g, '');
  const dot = ascii.indexOf('.');
  const intPart = dot >= 0 ? ascii.slice(0, dot) : ascii;
  const fracPart = dot >= 0 ? ascii.slice(dot + 1) : null;
  if (intPart.length > 15) return null; // absurdly long — leave untouched
  const intVal = parseInt(intPart, 10);
  let words;
  if (fracPart !== null) {
    const ones = lang === 'bn' ? BN_WORDS : lang === 'hi' ? HI_WORDS : EN_ONES;
    const digitWord = d => ones[Number(d)];
    words = intWords(intVal, lang) + SPOKEN[lang].point + [...fracPart].map(digitWord).join(' ');
  } else if (allowYear && !currency && !suffix && lang === 'en' && !/[,，]/.test(numRaw) && /^\d{4}$/.test(intPart) && intVal >= 1000 && intVal <= 2099) {
    words = enYear(intVal);
  } else {
    words = intWords(intVal, lang);
  }
  if (suffix) {
    words += suffix.includes('%') ? SPOKEN[lang].percent : SPOKEN[lang].times;
  }
  if (currency) {
    const c = CURRENCIES[currency];
    const singular = intVal === 1 && fracPart === null;
    words += ' ' + (lang === 'bn' ? c.bn : lang === 'hi' ? c.hi[singular ? 0 : 1] : (singular ? c.en[0] : c.en[1]));
  }
  return words;
}

/**
 * Rewrite every number in `text` as spoken words. Identifiers and code-like
 * tokens are left alone: digits glued to Latin letters (gpt-oss-120b),
 * ratios/times (9:16, 10:30), ISO dates (2026-11-01) and version strings.
 */
export function verbalizeNumbers(text) {
  let out = String(text);

  // Pass 1 — ranges ("10–15", "$10-20", "2020–2024").
  {
    const spans = sentenceSpans(out);
    out = out.replace(RANGE_RE, (raw, currency, a, b, suffix, offset, whole) => {
      const prev = offset > 0 ? whole[offset - 1] : '';
      const next = whole[offset + raw.length] || '';
      if (/[A-Za-z0-9:./_-]/.test(prev) || /[A-Za-z]/.test(next)) return raw;
      if ((next === '-' || next === '.') && /\d/.test(whole[offset + raw.length + 1] || '')) return raw; // ISO date / version string
      const lang = langAt(whole, spans, offset, a);
      const wa = numberWords(a, lang, { allowYear: true });
      const wb = numberWords(b, lang, { currency, suffix, allowYear: true });
      if (wa === null || wb === null) return raw;
      return wa + SPOKEN[lang].range + wb;
    });
  }

  // Pass 2 — single numbers.
  {
    const spans = sentenceSpans(out);
    out = out.replace(SINGLE_RE, (raw, currency, num, suffix, offset, whole) => {
      const prev = offset > 0 ? whole[offset - 1] : '';
      const next = whole[offset + raw.length] || '';
      if (/[A-Za-z0-9:./#_-]/.test(prev) || /[A-Za-z:]/.test(next)) return raw;
      if ((next === '-' || next === '.') && /\d/.test(whole[offset + raw.length + 1] || '')) return raw; // ISO date / version string
      const lang = langAt(whole, spans, offset, num);
      const words = numberWords(num, lang, { currency, suffix });
      return words === null ? raw : words;
    });
  }
  return out;
}

// ── Formatting cleanup ──────────────────────────────────────────────────────

/**
 * Remove what a speech engine cannot use: markdown emphasis/code/links,
 * image markup, HTML tags, brackets (their text stays — prep never changes
 * meaning), emoji and list/quote markers. Sentence punctuation is kept.
 */
export function cleanForTTS(text) {
  let t = String(text);
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');            // images: pure noise for a voice
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');          // links → their text
  t = t.replace(/\[([^\]]*)\]/g, '$1');                   // [bracketed] → text
  t = t.replace(/\(([^)]*)\)/g, '$1');                    // (parenthetical) → text
  t = t.replace(/<[^>]+>/g, ' ');                         // HTML tags
  t = t.replace(/[*`#~]+/g, '');                          // emphasis / code / heading / strike marks
  t = t.replace(/(^|\s)_([^_]+)_(?=\s|$|[.!?,;:…])/g, '$1$2'); // _italic_
  t = t.replace(/^\s*(?:[-•*]|>|\d+[.)])\s+/gm, '');      // list bullets, quote markers
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, ''); // emoji & pictographs
  t = t.replace(/\s+/g, ' ');
  t = t.replace(/\s+([.!?,;:…।])/g, '$1');                // space before punctuation
  return t.trim();
}

/** Full prep: cleanup first (it can expose numbers), then verbalize. */
export function prepForTTS(text) {
  return verbalizeNumbers(cleanForTTS(text));
}

// ── Sentence splitting (shared; moved from tts.mjs, behavior unchanged) ────

export const MAX_CHUNK_CHARS = 1200; // TTS handles long text, but smaller chunks fail softer

/** Split text into sentence-ish chunks of at most maxChars characters. */
export function splitSentences(text, maxChars = MAX_CHUNK_CHARS) {
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
