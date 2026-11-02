// langrule group — the narration-language rule (FIX B).
//
// Live 2026-11-02: for an ENGLISH topic the agent chose Bengali
// narration "since they've been writing in Bengali" — it let the
// owner's CHAT language decide the video's narration language. The
// rule now lives in all three places that steer the agent:
//   1. the 🎬 brief composer (bot/bot.mjs composeMakeBrief) — the
//      brief itself carries the line; its OUTPUT is asserted
//      end-to-end by tests/makeflow.test.mjs (exact-brief match),
//      here we pin the line's presence inside the composer;
//   2. the first-turn prefix (bot/conversation.mjs FIRST_TURN_PREFIX),
//      which orients every fresh session, brief or no brief;
//   3. the agent instructions (.opencode/agent/video-maker.md).
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const read = rel => readFileSync(`${ROOT}/${rel}`, 'utf8');
const assert = (c, m) => { if (!c) throw new Error(m); };

const LINE = 'Narration language: same as the topic (unless the owner said otherwise).';

// (1) The composed 🎬 brief carries the line — inside composeMakeBrief.
const botSrc = read('bot/bot.mjs');
const composerAt = botSrc.indexOf('function composeMakeBrief');
const lineAt = botSrc.indexOf(LINE);
const composerEnd = botSrc.indexOf('async function startMakeFlow');
assert(composerAt !== -1 && lineAt > composerAt && (composerEnd === -1 || lineAt < composerEnd),
  'composeMakeBrief output contains the narration-language line');
console.log('  ✓ brief composer emits "Narration language: same as the topic (unless the owner said otherwise)."');

// (2) The first-turn prefix states the rule for every fresh session.
const convSrc = read('bot/conversation.mjs');
assert(convSrc.includes('narration language follows the topic'),
  'FIRST_TURN_PREFIX: narration language follows the topic');
assert(convSrc.includes('must never decide it'),
  'FIRST_TURN_PREFIX: the chat language must never decide the narration language');
console.log('  ✓ first-turn prefix carries the rule (topic decides, chat language never does)');

// (3) The agent instructions state the rule, with the chat/narration split.
const md = read('.opencode/agent/video-maker.md');
assert(/Narration language follows the TOPIC/.test(md), 'video-maker.md: narration language follows the TOPIC');
assert(/unless he explicitly\s+names a narration language/.test(md), 'video-maker.md: explicit owner choice wins');
assert(/Never pick the narration language\s+from the language he is chatting in/.test(md),
  'video-maker.md: never pick the narration language from the chat language');
console.log('  ✓ video-maker.md carries the rule (topic language; chat language is for replies only)');

console.log('langrule: passed');
process.exit(0);
