// Smoke tests — no real keys needed. Covers:
//  1. SRT formatting from sample Whisper segments
//  2. Provider model-list filtering (Groq + NVIDIA sample payloads)
//  3. Bitrate-cap math (60s and 600s videos)
//  4. Bot flow against a MOCK Telegram API (tests/flow.test.mjs, child process)
import assert from 'node:assert';
import { spawn } from 'node:child_process';

import { segmentsToSrt, srtTime } from '../media/srt.mjs';
import { filterChatModels } from '../bot/models.mjs';
import { videoBitrateForTarget } from '../media/encode.mjs';
import { splitSentences } from '../media/tts.mjs';

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('— SRT —');
ok('srtTime formats', () => {
  assert.equal(srtTime(0), '00:00:00,000');
  assert.equal(srtTime(61.5), '00:01:01,500');
  assert.equal(srtTime(3661.234), '01:01:01,234');
});
ok('segmentsToSrt builds cues, drops empties, repairs ends', () => {
  const srt = segmentsToSrt([
    { start: 0, end: 2.5, text: ' Hello ' },
    { start: 2.5, end: 2.5, text: 'world' },
    { start: 9, end: 10, text: '   ' },
  ]);
  assert.match(srt, /1\n00:00:00,000 --> 00:00:02,500\nHello/);
  assert.match(srt, /2\n00:00:02,500 --> 00:00:03,500\nworld/);
  assert.ok(!srt.includes('\n3\n'));
});

console.log('— Model filtering —');
ok('Groq payload keeps chat models only', () => {
  const out = filterChatModels({ data: [
    { id: 'openai/gpt-oss-120b' }, { id: 'openai/gpt-oss-20b' }, { id: 'qwen/qwen3.8-27b' },
    { id: 'whisper-large-v3' }, { id: 'whisper-large-v3-turbo' },
    { id: 'canopylabs/orpheus-v1-english' }, { id: 'meta-llama/llama-prompt-guard-2-86m' },
  ] });
  assert.deepEqual(out, ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b']);
});
ok('NVIDIA payload drops embeddings/parse/safety specials', () => {
  const out = filterChatModels({ data: [
    { id: 'nvidia/nemotron-3-super-120b-a12b' }, { id: 'z-ai/glm-5.3' },
    { id: 'nvidia/nemotron-3-embed-1b' }, { id: 'nvidia/nemotron-parse' },
    { id: 'nvidia/nemotron-3.5-content-safety' }, { id: 'nvidia/nvclip' },
    { id: 'nvidia/riva-translate-4b-instruct-v1.1' },
  ] });
  assert.deepEqual(out, ['nvidia/nemotron-3-super-120b-a12b', 'z-ai/glm-5.3']);
});

console.log('— Bitrate math —');
ok('60s video fits 48MB with sane bitrate', () => {
  const bps = videoBitrateForTarget(60, 48 * 1024 * 1024);
  const totalMB = ((bps + 128000) * 60) / 8 / 1024 / 1024;
  assert.ok(totalMB <= 48 && totalMB > 40, `got ${totalMB.toFixed(1)}MB`);
  assert.ok(bps > 4_000_000);
});
ok('600s video gets a much lower bitrate but still fits', () => {
  const bps = videoBitrateForTarget(600, 48 * 1024 * 1024);
  const totalMB = ((bps + 128000) * 600) / 8 / 1024 / 1024;
  assert.ok(totalMB <= 48.5, `got ${totalMB.toFixed(1)}MB`);
  assert.ok(bps < 1_000_000);
});
ok('TTS sentence splitting respects chunk cap', () => {
  const chunks = splitSentences('One. Two! Three? ' + 'Long sentence here. '.repeat(200), 500);
  assert.ok(chunks.length > 3 && chunks.every(c => c.length <= 560));
});

console.log('— Mock Telegram flow (child process) —');
const code = await new Promise(resolve => {
  const p = spawn('node', ['tests/flow.test.mjs'], { stdio: 'inherit' });
  p.on('close', resolve);
});
assert.equal(code, 0, 'flow test failed');
passed++;

console.log('— Permission/question relay (child process, mock OpenCode server) —');
const relayCode = await new Promise(resolve => {
  const p = spawn('node', ['tests/relay.test.mjs'], { stdio: 'inherit' });
  p.on('close', resolve);
});
assert.equal(relayCode, 0, 'relay test failed');
passed++;

console.log('— Voice prep / takes / listener QC (child process) —');
const voiceCode = await new Promise(resolve => {
  const p = spawn('node', ['tests/voice.test.mjs'], { stdio: 'inherit' });
  p.on('close', resolve);
});
assert.equal(voiceCode, 0, 'voice test failed');
passed++;

console.log('— Bengali/Hindi support (child process) —');
const langCode = await new Promise(resolve => {
  const p = spawn('node', ['tests/lang.test.mjs'], { stdio: 'inherit' });
  p.on('close', resolve);
});
assert.equal(langCode, 0, 'lang test failed');
passed++;

console.log('— Model probe + fallback (child process, mock provider API) —');
const probeCode = await new Promise(resolve => {
  const p = spawn('node', ['tests/modelprobe.test.mjs'], { stdio: 'inherit' });
  p.on('close', resolve);
});
assert.equal(probeCode, 0, 'model probe test failed');
passed++;
console.log(`\nSMOKE: ${passed} groups passed`);
