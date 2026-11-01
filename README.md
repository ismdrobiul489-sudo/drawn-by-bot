# drawn-by-bot

A Telegram bot that makes **code-drawn videos**: send a topic, a script, or a
voice note — get back an animated video drawn entirely by JavaScript/Canvas
(no AI video), with narration and subtitles.

It is built around three pieces:

- **`core/`** — the [drawn-by-code](https://github.com/illodev/drawn-by-code)
  engine, styles and skills by illodev, copied in **renamed and completely
  unmodified** (see [UPSTREAM.md](UPSTREAM.md) for the pinned commit). Their
  work is treated as perfect: this project only wraps around it.
- **OpenCode** — the agentic framework that sits where Claude Code sat in the
  original workflow. It follows the repo's own process (brief → style test →
  animatic → review → final) and the project's own instructions
  (`AGENTS.md`, `.opencode/agent/video-maker.md`), powered by the user's
  choice of **Groq** or **NVIDIA** models — selected per job, with the model
  list fetched live from the provider (never hardcoded).
- **`bot/` + `media/`** — our own code: the Telegram conversation, the job
  queue and processor, and the media tools (Edge TTS, Groq Whisper → SRT,
  NVIDIA vision QC, delivery encoding, public-link store).

## The flow

```
/start → [💡 Topic | 📝 Script | 🎙️ Voice] → send content
       → Provider [Groq | NVIDIA] → Model (live list from that API key)
       → Style (from core/styles/) → Aspect [9:16 | 16:9]
       → Voice (live Edge TTS list, when narration is needed) → Confirm
```

- **Topic** → the agent writes the script, Edge TTS narrates it, the scene
  is built on the narration timing.
- **Script** → your text is narrated as-is, then animated.
- **Voice** → Groq Whisper transcribes it (transcript + SRT is a deliverable
  on its own), then the scene is built on its timing with your own audio.

One job runs at a time (FIFO queue). The agent renders a low-res **animatic
first** and sends it to the chat — you reply in plain language ("make the
sky warmer", "this part feels empty"), the bot forwards your words into
the **same OpenCode session**, and it revises. When you're happy you
press **✅ Final render**.
The finished master is stored and its **public backup link** travels with
the Telegram video (which is bitrate-capped to fit Telegram's bot limit
when needed). No duration limit: long videos are chunked underneath
(TTS by sentence, Whisper by 10-minute chunks, scenes by SRT segment) and
delivered by store link when they outgrow Telegram.

## Permissions & questions — answered with buttons, never typing

The agent runs on a long-lived `opencode serve` process (the `serve`
driver). Routine in-project work — running the engine, editing files
inside the job folder — is pre-approved in `opencode.json` and **never
asks you anything**. Only something outside that pattern (for example a
command the safety rules flag, or an agent loop) stops and asks:

- **Permission request** — you get a Telegram message saying in plain
  English what the agent wants to do (the tool, and the command or file
  it touches), with three buttons:
  - **✅ Yes** — allow this one time only
  - **♾️ Always for this job** — allow it for the rest of this session
  - **❌ No** — deny it; the agent works around it or reports back
- **Question** — when the agent needs a decision, you get the question
  as a message with **one button per option**. If a question has no
  options, just reply with a text message; your reply is the answer.

The job is **paused** while an ask is open (OpenCode itself waits), and
**nothing is ever auto-approved**: if you don't answer, the job simply
waits. After 30 minutes you get one reminder nudge. Pending asks are
saved to `data/pending.json`, so if the bot restarts mid-job the same
ask is re-sent when it comes back — it can never silently vanish.
Permissions outside the project folder are denied outright in
`opencode.json`, so they never even reach you.

Set `OPENCODE_DRIVER=run` in `.env` to fall back to the old one-shot
`opencode run` driver (used automatically if the server cannot start);
that driver has no button relay.

## Voice quality

The narration is built and checked in three stages — our own pipeline,
in `media/prep.mjs`, `media/tts.mjs` and `media/qc-audio.mjs`:

1. **Prep.** Before anything is synthesized, the script is cleaned for
   speech: formatting a voice engine would trip over is stripped, and
   numbers are written the way they are spoken (amounts, percents,
   decimals, ranges, years — in English for English text, in Bengali for
   Bengali text, in Hindi for Hindi text). Cleanup never changes the
   meaning or the facts.
2. **Sectioned multipass.** The agent splits the script into sections
   that follow the content — hook, body, outro — in `voice-plan.json`,
   and each section is synthesized separately, in order. With
   `TTS_TAKES=2`, every section gets a second take recorded at a small
   pitch offset, made at synthesis time.
3. **Listener test.** After the agent's turn, the bot listens back like a
   listener would: an ffmpeg silence scan flags abnormally long gaps,
   and (for audio up to `QC_WHISPER_MAX_SEC`, to protect the Groq free
   quota) a Whisper re-transcription is word-diffed against the exact
   text that was synthesized. The better take per section is picked
   automatically, a one-line summary rides along with the animatic in
   Telegram ("🎙️ Voice QC: clean" / "…2 long gaps, 1 mismatched word
   (hook)"), and on a fail the agent is asked to regenerate **only** the
   flagged sections. The full report lands in the job's `qc-audio.json`.

Honest limits: Edge TTS has **no true emotion control** — the plan's
`tone` and `emphasis` fields are production notes that shape how the
agent sections the script; they are not directives the engine obeys.
The only voice variation available is the pitch offset of a second
take, applied while synthesizing. Speed always stays 100: recorded
audio is never time-stretched or re-pitched after the fact.

## Languages

- **Narration voices** — the bot's voice step offers whatever the
  installed Edge TTS CLI reports for English, Bengali (bn-BD / bn-IN)
  and Hindi (hi-IN); Groq Whisper captioning covers the same languages
  and many more.
- **On-screen text** — the style kits' fonts are Latin-only, so the
  project ships its own SIL OFL fonts in `assets/fonts/`: **Noto Sans
  Bengali** and **Noto Sans Devanagari** (400 + 700). A scene copies
  the files it needs into its job folder and typesets Bengali runs in
  the Bengali family and Devanagari runs in the Devanagari family;
  Latin runs keep the kit fonts. See `assets/fonts/README.md`.
- **Script prep** — number verbalization speaks English, Bengali and
  Hindi, native digits included (Bengali ০-৯, Devanagari ०-९), each
  with its own lakh/crore grouping where the language uses it.

Honest remainder: any other non-Latin script (Arabic, Cyrillic, CJK…)
still needs its font added to `assets/fonts/` the same way before a
scene can show it, and Edge/Whisper coverage varies by language.

## Repo layout

```
core/                  upstream drawn-by-code, UNMODIFIED (see UPSTREAM.md)
bot/                   Telegram bot: telegram.mjs (API client), bot.mjs (flow),
                       models.mjs (dynamic model lists), styles.mjs, queue.mjs
                       (one active job), processor.mjs (job pipeline),
                       agent-server.mjs (opencode serve driver),
                       relay.mjs (permission/question → Telegram buttons)
media/                 tts.mjs (Edge TTS, sectioned plans + takes),
                       prep.mjs (script cleanup + number verbalization),
                       qc-audio.mjs (listener-test QC), whisper.mjs
                       (Groq Whisper → SRT), srt.mjs, qc-vision.mjs
                       (NVIDIA vision QC), encode.mjs (Telegram fit),
                       store.mjs (public links)
assets/fonts/          our OFL fonts for Bengali + Devanagari on-screen text
                       (Noto Sans Bengali / Noto Sans Devanagari, fonts.css,
                       load-fonts.js, licenses, README)
.opencode/             our custom agent + tools (tts / whisper / qcvision)
opencode.json          OpenCode providers (groq + nvidia), permissions
AGENTS.md              our standing instructions for the agent
deploy/                VPS setup.sh, systemd unit, go-live checklist,
                       fetch-core.sh (restore core/ at the pinned commit)
data/  store/          runtime state + stored masters (gitignored)
.env                   ALL configuration (never committed; see .env.example)
```

## Configuration

Everything lives in `.env` — copy `.env.example`, fill it in. It documents
every variable: bot token, owner id, Groq/NVIDIA keys and default models,
Whisper model, Edge TTS voice default, OpenCode binary/model/timeout,
Telegram size cap, public base URL, store port and retention. The bot is
**owner-only**: it ignores every Telegram user except `OWNER_TELEGRAM_ID`.

## Local dev / tests

```bash
node --check bot/*.mjs media/*.mjs lib/*.mjs tests/*.mjs   # syntax
npm test        # smoke: SRT, model filtering, bitrate math, mock-Telegram flow
npm start       # run the bot (needs a filled .env)
```

## Deploy (VPS) — the whole thing is three commands

```bash
git clone https://github.com/ismdrobiul489-sudo/drawn-by-bot.git
cd drawn-by-bot
bash install.sh     # installs EVERYTHING: Node 20+, ffmpeg, Chromium,
                    # Edge TTS, OpenCode, the engine's npm dependency,
                    # the systemd unit — and creates .env from the example
bash setup-env.sh   # answer 5 questions — it writes .env for you
                    # (no text editor needed; made for phone terminals)
bash run.sh         # preflight check + start the bot in this terminal
```

`.env` — what you must fill (everything else has working defaults):

| Variable | What it is |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token of the NEW bot from @BotFather |
| `OWNER_TELEGRAM_ID` | Your numeric Telegram id (the bot ignores everyone else) |
| `GROQ_API_KEY` | Your Groq key (jobs + Whisper) |
| `NVIDIA_API_KEY` | Your NVIDIA key (jobs + vision QC) |
| `PUBLIC_BASE_URL` | This server's public URL, so stored-video links open |

Prefer it always-on instead of a terminal? After `install.sh` and `.env`:
`sudo systemctl enable --now drawn-by-bot`, logs via
`sudo journalctl -u drawn-by-bot -f`. Full checklist in `deploy/README.md` —
including the **Edge TTS smoke test on the VPS first** (it was blocked from
the dev VM's network; the TTS is a swappable tool if a network blocks it).

## Honest status — what was NOT tested here

Development happened on a VM with **no real keys and no bot token**, so
these paths are written and unit/flow-tested but not live-fired:

- Real Telegram delivery (flow verified against a mock Bot API server).
- OpenCode actually driving a job end-to-end with a real Groq/NVIDIA key
  (OpenCode 1.19.5 itself was installed and its provider config verified
  here: `opencode models` lists both providers; sessions need keys).
  The serve driver's HTTP/SSE endpoints were verified live against the
  installed 1.19.5 server's own OpenAPI doc, and the permission/question
  relay is tested against a mock server implementing those exact shapes —
  but a real agent hitting a real permission prompt mid-job is still
  untested until the first live job on the VPS.
- Edge TTS synthesis from this machine (its network blocks the endpoint —
  a known, documented issue; test on the VPS per the checklist). The
  sectioned/takes flow is tested against a mock `edge-tts` binary that
  writes real mp3s, including the `--pitch` argument on take 2; whether
  the real service honours that pitch offset exactly as documented is a
  VPS-stage check.
- The listener QC's Whisper word check against a live Groq key (the
  silence scan, take picking, quota guard and report are all covered by
  tests with the word check disabled or absent).
- Groq Whisper calls from this code (the same account/endpoint was verified
  separately through the user's existing Groq connector; the key itself
  never leaves the connector, so this code takes its key from `.env`).
- The upstream engine's renders (its `setup.sh` and Chromium renders are
  VPS work — see deploy/README.md).

## Credit

Engine, styles and skills in `core/` are by **illodev**
(https://github.com/illodev/drawn-by-code) — see `core/LICENSE` and
[UPSTREAM.md](UPSTREAM.md). Everything outside `core/` is this project's
own code.
