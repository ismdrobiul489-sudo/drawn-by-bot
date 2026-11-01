// Job processor: brief → OpenCode session (in core/ as the project dir) →
// progress relay → animatic feedback loop → final render → vision QC →
// store + Telegram delivery. The upstream engine and kits are used exactly
// as they are; everything here is a wrapper around them.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { env, envInt, ROOT } from '../lib/env.mjs';
import { binaryExists, runStreaming } from '../lib/run.mjs';
import { fitForTelegram, MB } from '../media/encode.mjs';
import { storeFile } from '../media/store.mjs';
import { qcContactSheet } from '../media/qc-vision.mjs';

const CORE = join(ROOT, 'core');

export function slugify(text) {
  const s = String(text || 'video').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'video';
}

export function briefText(job) {
  const j = job;
  return `# Brief — ${j.id}

- Input mode: ${j.mode}
- Provider: ${j.provider}
- Model: ${j.model}
- OpenCode model id: ${j.provider}/${j.model}
- Style: ${j.style}
- Aspect: ${j.aspect} (${j.aspect === '9:16' ? '1080x1920' : '1920x1080'})
- Voice (Edge TTS): ${j.voice || '(none — user supplied audio or silent)'}
- Final render now: ${j.finalNow ? 'YES' : 'NO — render a low-res animatic first, then STOP and wait for the user feedback that will arrive as a follow-up message in this same session'}

## User input
${j.mode === 'voice' ? 'The user supplied an audio file: input-voice (see job folder). Transcribe it with the whisper tool — transcript + SRT only — then build the scene on its timing.' : j.inputText || ''}

## Files in this job folder
- brief.md (this file), input.txt (the user's topic/script, text modes)
- timing.json + captions.srt + voice.mp3 appear once the media tools have run

## Standing orders
Follow AGENTS.md and .opencode/agent/video-maker.md exactly. Use the engine
and the "${j.style}" kit in this repo UNMODIFIED. Write review.md with every
round, including the user's feedback quoted verbatim when it arrives.
`;
}

function opencodeModel(job) {
  return `${job.provider}/${job.model}`;
}

/**
 * Run one OpenCode message for a job (first run or a feedback follow-up).
 * Streams progress lines to onProgress (throttled by the caller).
 * Returns { sessionId }.
 */
export function runOpenCode(job, message, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const bin = env('OPENCODE_BIN', 'opencode');
    if (!binaryExists(bin)) {
      reject(new Error(`OpenCode binary "${bin}" পাওয়া যায়নি — VPS-এ deploy/setup.sh চালিয়ে install করুন, বা .env-তে OPENCODE_BIN ঠিক করুন।`));
      return;
    }
    const args = ['run', '--format', 'json', '--model', opencodeModel(job)];
    if (job.sessionId) args.push('--session', job.sessionId);
    args.push(message);
    const timeoutMs = envInt('OPENCODE_TIMEOUT_MIN', 120) * 60000;
    const { child, done } = runStreaming(bin, args, {
      cwd: CORE,
      onLine(line) {
        try {
          const ev = JSON.parse(line);
          const sid = ev.sessionID || ev.sessionId || ev.part?.sessionID;
          if (sid && !job.sessionId) job.sessionId = sid;
          const text = ev.part?.text || ev.text || '';
          if (text && onProgress) onProgress(String(text).slice(0, 300));
        } catch { /* non-JSON progress line */ }
      },
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    done.then(code => {
      clearTimeout(timer);
      if (code === 0) resolve({ sessionId: job.sessionId });
      else reject(new Error(`OpenCode run শেষ হয়েছে code ${code} দিয়ে।`));
    }, err => { clearTimeout(timer); reject(err); });
  });
}

function firstRunMessage(job) {
  return [
    `New video job ${job.id}. Work ONLY inside sandbox/${job.folderName}/ in this repo.`,
    `Read sandbox/${job.folderName}/brief.md and follow it exactly.`,
    `Use the video-maker agent playbook for mode "${job.mode}".`,
    job.finalNow
      ? 'The brief says FINAL: go all the way to the finished, mastered render in render/.'
      : 'The brief says ANIMATIC FIRST: build everything, render a low-res animatic + contact sheet into render/, write review.md, then stop and summarise what you made and what you are unsure about.',
  ].join(' ');
}

/** Find the newest mp4 under the job's render/ folder. */
export function findRender(jobDir) {
  const dir = join(jobDir, 'render');
  if (!existsSync(dir)) return null;
  const mp4s = readdirSync(dir).filter(f => f.endsWith('.mp4'))
    .map(f => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return mp4s.length ? join(dir, mp4s[0].f) : null;
}

export function findSheet(jobDir) {
  const dir = join(jobDir, 'render');
  if (!existsSync(dir)) return null;
  const sheets = readdirSync(dir).filter(f => /sheet|strip/i.test(f) && /\.(jpe?g|png)$/i.test(f))
    .map(f => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (sheets.length) return join(dir, sheets[0].f);
  const any = readdirSync(dir).filter(f => /\.(jpe?g|png)$/i.test(f));
  return any.length ? join(dir, any[0]) : null;
}

/**
 * Create the job folder + brief, then run the processor.
 * hooks: { status(text), sendAnimatic(job, renderPath, sheetPath), deliver(job, result) }
 */
export async function processJob(job, hooks) {
  const date = new Date(job.createdAt || Date.now());
  const ymd = date.toISOString().slice(0, 10);
  job.folderName = `${ymd}-${slugify(job.mode === 'voice' ? 'voice-video' : job.inputText)}`;
  job.jobDir = join(CORE, 'sandbox', job.folderName);
  mkdirSync(join(job.jobDir, 'render'), { recursive: true });
  writeFileSync(join(job.jobDir, 'brief.md'), briefText(job));
  if (job.inputText) writeFileSync(join(job.jobDir, 'input.txt'), job.inputText);
  if (job.inputAudioPath) {
    const { copyFileSync } = await import('node:fs');
    const dest = join(job.jobDir, `input-voice${job.inputAudioExt || '.ogg'}`);
    copyFileSync(job.inputAudioPath, dest);
    job.inputAudioInJob = dest;
  }

  let lastRelay = 0;
  const onProgress = text => {
    const now = Date.now();
    if (now - lastRelay > 20000) { lastRelay = now; hooks.status(`⏳ ${job.id}: ${text}`); }
  };

  await hooks.status(`🎬 ${job.id} শুরু হলো — mode: ${job.mode}, style: ${job.style}, ${job.aspect}, model: ${job.provider}/${job.model}`);
  await runOpenCode(job, firstRunMessage(job), { onProgress });

  const render = findRender(job.jobDir);
  if (!render) throw new Error('OpenCode run শেষ, কিন্তু render/ ফোল্ডারে কোনো .mp4 পাওয়া যায়নি। review.md দেখুন।');

  if (!job.finalNow) {
    // Animatic stage: hand the preview to the user; feedback continues this
    // same OpenCode session via sendFeedback(), final via finalizeJob().
    job.stage = 'awaiting-feedback';
    await hooks.sendAnimatic(job, render, findSheet(job.jobDir));
    return { animatic: true };
  }
  return finalizeJob(job, hooks, render);
}

/** Continue the session with one user feedback message. */
export async function sendFeedback(job, text, hooks) {
  await runOpenCode(job, `User feedback (quote it verbatim in review.md, apply it, re-render the animatic + contact sheet, then stop again): ${text}`, {});
  const render = findRender(job.jobDir);
  if (render) await hooks.sendAnimatic(job, render, findSheet(job.jobDir));
  return render;
}

/** Final render + QC + store + delivery. */
export async function finalizeJob(job, hooks, knownRender) {
  if (!knownRender) {
    await runOpenCode(job, 'User approved: render the FINAL full-resolution master now (mastering −16 LUFS / TP −1.2), update review.md, and delete frames/ after a successful render.', {});
  }
  const render = knownRender || findRender(job.jobDir);
  if (!render) throw new Error('Final render পাওয়া যায়নি।');

  // Vision QC is advisory: it never blocks delivery, it reports.
  let qc = null;
  const sheet = findSheet(job.jobDir);
  if (sheet && env('NVIDIA_API_KEY')) {
    try { qc = await qcContactSheet(sheet); } catch (e) { qc = { pass: null, issues: [`QC চলেনি: ${e.message}`] }; }
  }

  const stored = storeFile(job.id, render);
  const fit = await fitForTelegram(render, join(job.jobDir, 'render', 'delivery.mp4'), envInt('TELEGRAM_MAX_MB', 48) * MB);
  job.result = { master: render, storedUrl: stored.url, deliveryFile: fit.file, reencoded: fit.reencoded, qc };
  await hooks.deliver(job, job.result);
  return job.result;
}
