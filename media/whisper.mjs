// Groq Whisper: audio → transcript.txt + captions.srt + timing.json in a job
// folder. Long audio is split into <=10-minute chunks (also keeps each upload
// well under Groq's 25 MB request limit); chunks are transcribed SEQUENTIALLY
// and their segments merged with time offsets. Uses GROQ_API_KEY from .env.
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { env } from '../lib/env.mjs';
import { run } from '../lib/run.mjs';
import { probe } from './encode.mjs';
import { segmentsToSrt } from './srt.mjs';

const CHUNK_SEC = 600;

async function toMonoMp3(input, output, ss, t) {
  const args = ['-y'];
  if (ss) args.push('-ss', String(ss));
  args.push('-i', input);
  if (t) args.push('-t', String(t));
  args.push('-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', output);
  await run('ffmpeg', args, { timeoutMs: 1000 * 60 * 30 });
}

async function transcribeChunk(mp3Path, apiKey, baseUrl, model) {
  const data = await import('node:fs').then(fs => fs.readFileSync(mp3Path));
  const form = new FormData();
  form.append('file', new Blob([data], { type: 'audio/mpeg' }), basename(mp3Path));
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  const res = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Groq Whisper HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return res.json();
}

/**
 * Transcribe `inputAudio` into `jobDir`.
 * Returns { transcriptPath, srtPath, timingPath, segments }.
 */
export async function transcribeToSrt(inputAudio, jobDir) {
  const apiKey = env('GROQ_API_KEY');
  if (!apiKey) throw new Error('GROQ_API_KEY is not set in .env — Whisper cannot run.');
  const baseUrl = env('GROQ_BASE_URL', 'https://api.groq.com/openai/v1').replace(/\/$/, '');
  const model = env('WHISPER_MODEL', 'whisper-large-v3');
  mkdirSync(jobDir, { recursive: true });

  const { durationSec } = await probe(inputAudio);
  const chunks = [];
  if (durationSec > CHUNK_SEC) {
    for (let off = 0; off < durationSec; off += CHUNK_SEC) chunks.push({ off, len: Math.min(CHUNK_SEC, durationSec - off) });
  } else chunks.push({ off: 0, len: 0 });

  const allSegments = [];
  let fullText = '';
  for (let i = 0; i < chunks.length; i++) {
    const { off, len } = chunks[i];
    const mp3 = join(jobDir, `_whisper_${i}.mp3`);
    await toMonoMp3(inputAudio, mp3, off, len);
    if (statSync(mp3).size > 24 * 1024 * 1024) throw new Error(`Whisper chunk ${i} still >24MB after compression; lower the chunk length.`);
    const json = await transcribeChunk(mp3, apiKey, baseUrl, model); // sequential on purpose
    for (const seg of json.segments || []) {
      allSegments.push({ start: (Number(seg.start) || 0) + off, end: (Number(seg.end) || 0) + off, text: seg.text || '' });
    }
    fullText += (json.text || '') + ' ';
  }
  allSegments.sort((a, b) => a.start - b.start);

  const transcriptPath = join(jobDir, 'transcript.txt');
  const srtPath = join(jobDir, 'captions.srt');
  const timingPath = join(jobDir, 'timing.json');
  writeFileSync(transcriptPath, fullText.trim() + '\n');
  writeFileSync(srtPath, segmentsToSrt(allSegments));
  writeFileSync(timingPath, JSON.stringify({ source: 'whisper', cues: allSegments }, null, 2));
  return { transcriptPath, srtPath, timingPath, segments: allSegments };
}

// CLI: node media/whisper.mjs <audio-file> <job-dir>
if (import.meta.url === `file://${process.argv[1]}`) {
  const [audio, dir] = process.argv.slice(2);
  if (!audio || !dir) { console.error('usage: whisper.mjs <audio> <job-dir>'); process.exit(2); }
  transcribeToSrt(audio, dir)
    .then(r => console.log(JSON.stringify({ ok: true, ...r, segments: r.segments.length })))
    .catch(e => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
}
