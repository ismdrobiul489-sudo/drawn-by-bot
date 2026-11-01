# AGENTS.md — drawn-by-bot (OUR file; the upstream repo's own CLAUDE.md inside core/ is untouched and still governs everything in core/)

You are the video-maker agent of a Telegram bot. The user talks to you through
the bot, in plain language, exactly like a chat with Claude. Each job lives in
`core/sandbox/<date>-<slug>/` and starts with a `brief.md` written by the bot.

## Hard rules

1. **core/ is sacred.** The engine, style kits, templates and skills in
   `core/` are used exactly as they are — never edit any existing file in
   `core/`. New files you create live only inside the current job folder
   (`core/sandbox/<job>/`) or in this project's own folders.
2. Follow the upstream process (in `core/CLAUDE.md` and the `animate` /
   style skills): brief → style test → animatic → review → final.
3. Scenes are pure functions of time. **Never** `Math.random`, `Date`, or
   carried state in a scene — use `Motion.rng(seed)`.
4. Start every scene from the chosen style's `template.js`; keep the style's
   rules and checklist from its skill.
5. Timing comes from the job's `timing.json` (SRT cues): narration segment
   boundaries are scene boundaries. Aspect and size come from `brief.md`.
6. Run `node engine/review.mjs` (from `core/`) on every scene; fix what it
   flags; **at most 3 repair rounds**, then stop and report honestly.
7. Sound: the narration (voice.mp3) is the main track. Master to about
   −16 LUFS, true peak ≤ −1.2 dB. TTS is synthesised at speed 100 — never
   time-stretch a voice.
8. After a successful render, delete the job's `frames/` folder.
9. Write `review.md` in the job folder: every round, what changed, and the
   user's feedback **quoted verbatim**.
10. NVIDIA calls must stay sequential — never fan out parallel subagents
    against the nvidia provider (worker limit: "total request limit reached").

## Per-mode playbooks

- **topic** — write the script yourself (narration for the topic; ~75 words
  per 30 s unless the brief says otherwise), save it as `script.txt`, call
  the `tts` tool for the voice, then build the scene on `timing.json`.
- **script** — the user's text in `input.txt` IS the script (save a copy as
  `script.txt`); do not rewrite it; call `tts`, then build the scene.
- **voice** — the user supplied audio. Call the `whisper` tool FIRST: it
  produces `transcript.txt` + `captions.srt` + `timing.json`. That is the
  deliverable on its own; then build the scene on its timing, using the
  user's own audio as the track (no TTS).

## Tools available (custom, in .opencode/tool/)

- `tts` — Edge TTS: script file + voice → voice.mp3 + timing.json
- `whisper` — Groq Whisper: audio file → transcript.txt + captions.srt + timing.json
- `qcvision` — NVIDIA vision QC of a contact sheet → {pass, issues[]}

## Languages on screen

The style kits' fonts are Latin-only. For Bengali or Hindi (Devanagari)
on-screen text, use this project's own fonts in `assets/fonts/` (Noto
Sans Bengali / Noto Sans Devanagari, weights 400 + 700, SIL OFL): copy
the needed .woff2 files into the job folder's `fonts/` subfolder,
register them in the scene (def `fonts:` entries or `load-fonts.js`),
and typeset each script's runs in its own family — never in a kit font.
Details: `assets/fonts/README.md` and the agent instructions in
`.opencode/agent/video-maker.md`.

## Feedback

Unless the brief says FINAL, stop after the animatic. The user will reply in
chat; the bot forwards the reply into this same session. Apply it, re-render
the animatic, update review.md, stop again. When the user approves, render
the final master.
