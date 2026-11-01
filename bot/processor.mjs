// Job processor: brief → OpenCode session (in core/ as the project dir) →
// progress relay → animatic feedback loop → final render → vision QC →
// store + Telegram delivery. The upstream engine and kits are used exactly
// as they are; everything here is a wrapper around them.
//
// Two drivers, picked by OPENCODE_DRIVER in .env:
//   serve (default) — one long-lived `opencode serve` process; turns are
//     prompts into a per-job session, and the agent's permission/question
//     asks are relayed to Telegram as buttons (bot/relay.mjs).
//   run — the original `opencode run --format json` one-shot driver, kept
//     as a fallback if the server cannot start (no button relay there).
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env, envInt, ROOT } from '../lib/env.mjs';
import { binaryExists, runStreaming } from '../lib/run.mjs';
import { fitForTelegram, MB } from '../media/encode.mjs';
import { storeFile } from '../media/store.mjs';
import { qcContactSheet } from '../media/qc-vision.mjs';
import { qcAudio, summarizeQc } from '../media/qc-audio.mjs';
import { resolveWorkingModel } from './models.mjs';
import { agentServer } from './agent-server.mjs';

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
${j.mode === 'voice' ? "The user supplied their voice script as an audio file: input-voice (see job folder). Transcribe it with the whisper tool — the transcript IS the script. Build the scene on its timing and use the user's audio itself as the narration track. Do NOT generate a script and do NOT use TTS." : j.inputText || ''}

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

/** Which OpenCode driver is active: "serve" (default) or "run" (fallback). */
export function openCodeDriver() {
  return env('OPENCODE_DRIVER', 'serve').toLowerCase() === 'run' ? 'run' : 'serve';
}

// ── serve driver (agent-server.mjs) ─────────────────────────────────────────

async function runOpenCodeServe(job, message, { onProgress, relay } = {}) {
  await agentServer.ensure();
  if (!job.sessionId) {
    job.sessionId = await agentServer.createSession({
      providerID: job.provider, modelID: job.model, title: job.id,
    });
  }
  // Route this session's permission/question asks to the owner's chat.
  relay?.attach(job.sessionId, job.chatId, job.id);
  agentServer.setProgress(job.sessionId, onProgress);
  try {
    await agentServer.prompt(job.sessionId, message, {
      providerID: job.provider, modelID: job.model,
    });
  } finally {
    agentServer.setProgress(job.sessionId, null);
  }
  return { sessionId: job.sessionId };
}

// ── run driver (fallback: `opencode run --format json`, one process/turn) ──

export function runOpenCodeRun(job, message, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const bin = env('OPENCODE_BIN', 'opencode');
    if (!binaryExists(bin)) {
      reject(new Error(`OpenCode binary "${bin}" not found — run deploy/setup.sh on the VPS, or fix OPENCODE_BIN in .env.`));
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
      else reject(new Error(`OpenCode run finished with code ${code}.`));
    }, err => { clearTimeout(timer); reject(err); });
  });
}

/**
 * Run one OpenCode message for a job (first run or a feedback follow-up).
 * hooks may carry { onProgress, relay } — the relay wires the session's
 * permission/question asks to Telegram buttons (serve driver only).
 */
export async function runOpenCode(job, message, hooks = {}) {
  if (openCodeDriver() === 'run') return runOpenCodeRun(job, message, hooks);
  try {
    await agentServer.ensure();
  } catch (e) {
    // ONLY a server that cannot start falls back to the one-shot driver —
    // a turn that already ran must never be silently re-run by `run`.
    console.error(`[processor] OpenCode server unavailable (${e.message}) — falling back to "opencode run"`);
    return runOpenCodeRun(job, message, hooks);
  }
  return runOpenCodeServe(job, message, hooks);
}

/**
 * Verify the job's chosen model actually answers (1-token probe chain in
 * bot/models.mjs) and fall back if it is dead: the provider's default model
 * from .env, then the other provider's default. A fallback updates
 * job.provider/job.model, marks job.modelFellBack, and is announced via
 * hooks.status; every step is also kept on job.modelNotices (the job log).
 * Throws — loudly, naming everything that was tried — when no model
 * answers at all, so a job never dies silently on a dead model.
 */
export async function ensureWorkingModel(job, hooks = {}) {
  const requested = `${job.provider}/${job.model}`;
  const notices = [];
  const notify = text => {
    notices.push(text);
    job.modelNotices = notices;
    return hooks.status ? hooks.status(`⚠️ ${job.id}: ${text}`) : undefined;
  };
  const res = await resolveWorkingModel(job.provider, job.model, notify);
  if (!res.provider) {
    const detail = res.tried.map(t => `${t.provider}/${t.model} (${t.error || 'no response'})`).join('; ');
    throw new Error(`No working model found — the job cannot start. Tried: ${detail}. Check the API keys in .env or pick a different model.`);
  }
  job.modelResolution = res;
  if (res.fellBack) {
    const bad = res.tried.find(t => !t.ok);
    job.provider = res.provider;
    job.model = res.model;
    job.modelFellBack = true;
    await hooks.status?.(`⚠️ Model ${requested} didn't respond (${bad?.error || 'error'}) — switched to ${res.provider}/${res.model}. Job continues.`);
  }
  return res;
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
 * Listener-test the job's voice (media/qc-audio.mjs) and store the one-line
 * summary on job.voiceQcSummary for the preview/delivery messages. On a
 * "fail" verdict the agent gets ONE automatic follow-up turn that names
 * qc-audio.json and may regenerate ONLY the flagged sections; QC then runs
 * once more. Voice mode (user audio) has no TTS voice to test — skipped.
 * QC problems never fail the job itself; they are reported.
 */
async function runVoiceQc(job, hooks, onProgress) {
  if (job.mode === 'voice') return;
  if (!existsSync(join(job.jobDir, 'voice.mp3'))) return;
  const qcOpts = { scriptFile: join(job.jobDir, 'script.txt') };
  try {
    let qc = await qcAudio(job.jobDir, qcOpts);
    if (qc.verdict === 'fail') {
      await hooks.status(`🎙️ ${job.id}: the listener test flagged the voice — asking the agent to regenerate only the flagged sections…`);
      await runOpenCode(job, [
        'The automatic listener test on voice.mp3 FAILED. Read qc-audio.json in your job folder for the exact flags (long gaps and/or mismatched words, per section).',
        'Regenerate ONLY the flagged sections: edit voice-plan.json for those sections only, re-run the tts tool with the plan, then re-render what the brief asked for (animatic or final) plus the contact sheet, and update review.md.',
        'Do not redo sections that passed, and do not change the script\'s meaning.',
      ].join(' '), { onProgress, relay: hooks.relay });
      qc = await qcAudio(job.jobDir, qcOpts);
    }
    job.voiceQcSummary = summarizeQc(qc);
    job.voiceQcPath = join(job.jobDir, 'qc-audio.json');
  } catch (e) {
    console.error(`[processor] voice QC did not run for ${job.id}: ${e.message}`);
    job.voiceQcSummary = `🎙️ Voice QC: did not run (${e.message})`;
  }
}

/**
 * Create the job folder + brief, then run the processor.
 * hooks: { status(text), relay, sendAnimatic(job, renderPath, sheetPath),
 *          deliver(job, result) }
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

  await hooks.status(`🎬 ${job.id} started — mode: ${job.mode}, style: ${job.style}, ${job.aspect}, model: ${job.provider}/${job.model}`);

  // Dead-model guard (both drivers — runOpenCode reads job.provider/model
  // at call time): probe the chosen model and fall back BEFORE the first
  // turn. The brief is rewritten when the model changed, so the session
  // brief names the model that will actually run.
  await ensureWorkingModel(job, hooks);
  if (job.modelFellBack) writeFileSync(join(job.jobDir, 'brief.md'), briefText(job));
  try {
    await runOpenCode(job, firstRunMessage(job), { onProgress, relay: hooks.relay });
  } catch (e) {
    // Mid-flight guard: the probe passed but the first turn still died of
    // a model problem (not provisioned, 404…) and no fallback has happened
    // yet — re-resolve once, skipping the model that just failed, and
    // retry the turn once with the working model.
    if (job.modelFellBack || !/model|404|not found|not provisioned/i.test(e.message || '')) throw e;
    const failed = `${job.provider}/${job.model}`;
    const res = await resolveWorkingModel(job.provider, job.model, () => {}, { skip: [failed] });
    if (!res.provider) throw e;
    job.provider = res.provider;
    job.model = res.model;
    job.modelFellBack = true;
    job.modelResolution = res;
    await hooks.status(`⚠️ Model ${failed} failed during the first turn (${e.message}) — switched to ${res.provider}/${res.model} and retrying once.`);
    writeFileSync(join(job.jobDir, 'brief.md'), briefText(job));
    await runOpenCode(job, firstRunMessage(job), { onProgress, relay: hooks.relay });
  }

  // The voice exists by now (the turn made it): listener-test it before the
  // render is picked, so a QC fix turn's re-render is the one delivered.
  await runVoiceQc(job, hooks, onProgress);

  const render = findRender(job.jobDir);
  if (!render) throw new Error('The OpenCode run finished, but no .mp4 was found in the render/ folder. See review.md.');

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
  await runOpenCode(job, `User feedback (quote it verbatim in review.md, apply it, re-render the animatic + contact sheet, then stop again): ${text}`, { relay: hooks.relay });
  const render = findRender(job.jobDir);
  if (render) await hooks.sendAnimatic(job, render, findSheet(job.jobDir));
  return render;
}

/** Final render + QC + store + delivery. */
export async function finalizeJob(job, hooks, knownRender) {
  if (!knownRender) {
    await runOpenCode(job, 'User approved: render the FINAL full-resolution master now (mastering −16 LUFS / TP −1.2), update review.md, and delete frames/ after a successful render.', { relay: hooks.relay });
  }
  const render = knownRender || findRender(job.jobDir);
  if (!render) throw new Error('Final render not found.');

  // Vision QC is advisory: it never blocks delivery, it reports.
  let qc = null;
  const sheet = findSheet(job.jobDir);
  if (sheet && env('NVIDIA_API_KEY')) {
    try { qc = await qcContactSheet(sheet); } catch (e) { qc = { pass: null, issues: [`QC did not run: ${e.message}`] }; }
  }

  const stored = storeFile(job.id, render);
  const fit = await fitForTelegram(render, join(job.jobDir, 'render', 'delivery.mp4'), envInt('TELEGRAM_MAX_MB', 48) * MB);
  job.result = { master: render, storedUrl: stored.url, deliveryFile: fit.file, reencoded: fit.reencoded, qc };
  await hooks.deliver(job, job.result);
  return job.result;
}
