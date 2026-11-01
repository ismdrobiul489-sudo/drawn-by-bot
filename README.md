# drawn-by-bot

A Telegram bot that makes **code-drawn videos** — and that you use like a
chatbot, not a form. You talk to it in plain language ("make a video about
monsoon rain", "here's my script — narrate it as-is", or a voice message
with your own recorded narration) and it writes, narrates, draws and
renders the video, asking you questions as buttons when something
material is missing, and sending previews and finished videos back into
the same chat. The video itself is drawn entirely by JavaScript/Canvas
(no AI video), with narration and subtitles.

It is built around three pieces:

- **`core/`** — the [drawn-by-code](https://github.com/illodev/drawn-by-code)
  engine, styles and skills by illodev, copied in **renamed and completely
  unmodified** (see [UPSTREAM.md](UPSTREAM.md) for the pinned commit). Their
  work is treated as perfect: this project only wraps around it.
- **OpenCode** — the agentic framework that sits where Claude Code sat in the
  original workflow. One persistent session per conversation follows the
  repo's own process (brief → style test → animatic → review → final) and
  the project's own instructions (`AGENTS.md`,
  `.opencode/agent/video-maker.md`), powered by **Groq** or **NVIDIA**
  models. A standing current selection (starting from the `.env`
  defaults) powers every turn — the bot never asks about provider or
  model; the selection changes only when the owner runs `/model`, which
  picks from the provider's live model list (never hardcoded).
- **`bot/` + `media/`** — our own code: the Telegram front end and the
  conversation bridge, and the media tools the agent uses (Edge TTS, Groq
  Whisper → SRT, NVIDIA vision QC, delivery encoding, public-link store).

## How you use it — just talk

There is **no form and no job queue**. Open the chat and write what you
want, in your own words (Bengali or English — the agent replies in the
language you use). The agent judges from context which input you sent:

- **A topic** → it writes the script, Edge TTS narrates it, the scene is
  built on the narration timing.
- **A full script** → your text is narrated as-is, then animated.
- **A voice script** → you record the *full narration* yourself and send
  it as a voice/audio message. The bot transcribes it automatically
  (Groq Whisper); the transcript *is* the script and its timing, and
  **your recording is the narration track** — no script is generated and
  no TTS is used.

Photos and files you send land in `data/inbox/` and are mentioned to the
agent with their path, so you can e.g. send a reference image and say
what to do with it.

While the agent works you get short progress messages at real milestones,
and previews (style test, animatic) are **sent into the chat as files**.
Reply in plain language ("make the sky warmer", "this part feels empty")
and it revises in the same conversation. If you write while a turn is
still running, your message is queued and handed to the agent as the
next turn — handy for mid-work corrections. The finished video is
delivered the same way, with a one-line summary. Oversize masters are
bitrate-capped to fit Telegram's bot limit, with the full-quality file
kept in the store and linked. No duration limit: long videos are chunked
underneath (TTS by sentence, Whisper by 10-minute chunks).

The only commands left are the rigid helpers:

| Command | What it does |
|---|---|
| `/start` | Wake the agent + status (current model, conversation state, how to just talk) |
| `/new` | Archive this conversation and start a fresh one |
| `/model` | Change the current model — the ONLY place it changes |
| `/cancel` | Stop the running turn (or clear queued messages) |
| `/help` | One message explaining the conversational way of working |

**Provider/model are never asked.** Every turn silently uses the
**current model**, which starts as the `.env` defaults
(`DEFAULT_PROVIDER` + that provider's `*_DEFAULT_MODEL`) and persists in
`data/state.json`. `/model` shows the current selection and lets you
pick another from the provider's live list; the new selection applies
from the next turn and stays until you change it again.

**One conversation = one video.** A session opens with your request,
carries that video's revisions and feedback, and **ends when the
finished video is delivered** (the agent's delivery tool marks it
final; the bot then archives the session — see `pastSessions` in
`data/state.json`). Your next message starts a fresh session. `/new`
rotates manually at any time; a conversation with no final delivery
simply stays open.

**Continuity comes from the agent's memory, not from session length.**
The agent maintains two small files in `data/memory/`:

- **`preferences.md`** — the core only: your standing choices ("from
  now on, always 9:16", "default style: line"), the language you write
  in, proven rules. State a preference in chat and the agent records it
  the moment you say it (editing the line in place if you later revise
  it) and confirms in one line.
- **`index.md`** — one line per finished video: date — title — job
  folder. Nothing else; it exists so a previous video can be found and
  resent if you ask.

When a new session starts, the bot prepends a compact memory brief —
the full preferences plus the last ~10 index lines (capped at ~4000
characters) — to your first message, so the agent picks up your
defaults silently and never re-asks what they already answer.

**Dead models never fail silently.** A listed model can still be dead
when called — so before the *first turn of a new conversation*, the
current model is verified with a 1-token API probe. If it doesn't
answer, the bot automatically falls back to that provider's `.env`
default, then to the other provider's default, posts a persistent
Telegram message saying which model it switched to, and saves the new
selection. The same guard covers a turn that dies mid-conversation of a
free-tier token limit (Groq free caps a turn at 8K tokens/min while a
fresh conversation's first turn is ~10.7K — that combination can never
work, so the turn is switched and retried once, with a note). If nothing
answers at all, you get a loud message in chat naming everything tried —
never silence. Run `node scripts/check-models.mjs` any time to see
which of your models are alive right now.

**A turn can never end in silence.** Every message gets a "🤔 On it…"
the moment work starts. The agent's text is streamed live, and when a
turn settles the bot ALSO fetches the session's stored messages and
delivers anything the stream missed — if a turn still ends with no
text, no file and no question pending, you get a plain notice saying
so. A watchdog (`TURN_STALL_MIN`, default 3 minutes without any agent
activity; `TURN_MAX_MIN`, default 15 minutes total) stops a turn whose
model stopped answering and tells you, naming the model. Permission and
question asks are additionally re-polled from the server every
`ASK_POLL_SEC` seconds, so they reach you even if the event stream is
down. And the bot takes a single-instance lock (`data/bot.lock`): a
second copy started by accident exits immediately with a clear
message instead of splitting your Telegram updates with the first.

## Permissions & questions — answered with buttons, never typing

The agent runs on a long-lived `opencode serve` process. Routine
in-project work — running the engine, editing files inside a video's
sandbox folder — is pre-approved in `opencode.json` and **never asks you
anything**. Only something outside that pattern (for example a command
the safety rules flag, or an agent loop) stops and asks:

- **Permission request** — you get a Telegram message saying in plain
  English what the agent wants to do (the tool, and the command or file
  it touches), with three buttons:
  - **✅ Yes** — allow this one time only
  - **♾️ Always for this job** — allow it for the rest of this session
  - **❌ No** — deny it; the agent works around it or reports back
- **Question** — when the agent needs a decision (a style? an aspect?),
  you get the question as a message with **one button per option**. If a
  question has no options, just reply with a text message; your reply is
  the answer.

The conversation is **paused** while an ask is open (OpenCode itself
waits), and **nothing is ever auto-approved**: if you don't answer, the
agent simply waits. After 30 minutes you get one reminder nudge.
Pending asks are saved to `data/pending.json`, so if the bot restarts
mid-conversation the same ask is re-sent when it comes back — it can
never silently vanish. Permissions outside the project folder are
denied outright in `opencode.json`, so they never even reach you.

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
3. **Listener test.** Voice QC is a step in the agent's own production
   loop: before delivering, it runs `node media/qc-audio.mjs
   <job-folder>`, which listens back like a listener would — an ffmpeg
   silence scan flags abnormally long gaps, and (for audio up to
   `QC_WHISPER_MAX_SEC`, to protect the Groq free quota) a Whisper
   re-transcription is word-diffed against the exact text that was
   synthesized. The better take per section is picked automatically,
   and on a flag the agent regenerates **only** the flagged sections
   and re-runs the check. The full report lands in the job's
   `qc-audio.json`, and the agent mentions the outcome in its summary.

Honest limits: Edge TTS has **no true emotion control** — the plan's
`tone` and `emphasis` fields are production notes that shape how the
agent sections the script; they are not directives the engine obeys.
The only voice variation available is the pitch offset of a second
take, applied while synthesizing. Speed always stays 100: recorded
audio is never time-stretched or re-pitched after the fact.

## Languages

- **Narration voices** — the agent's TTS tool draws on whatever the
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
bot/                   Telegram bot: telegram.mjs (API client + resilient
                       polling), bot.mjs (commands + routing),
                       conversation.mjs (persistent-session bridge,
                       model guards, claims check), outbox.mjs (send_file
                       delivery watcher), models.mjs (dynamic model
                       lists + probes), agent-server.mjs (opencode serve
                       driver + respawn), relay.mjs (permission/question
                       → Telegram buttons)
media/                 tts.mjs (Edge TTS, sectioned plans + takes),
                       prep.mjs (script cleanup + number verbalization),
                       qc-audio.mjs (listener-test QC), whisper.mjs
                       (Groq Whisper → SRT), srt.mjs, qc-vision.mjs
                       (NVIDIA vision QC), encode.mjs (Telegram fit),
                       store.mjs (public links)
assets/fonts/          our OFL fonts for Bengali + Devanagari on-screen text
                       (Noto Sans Bengali / Noto Sans Devanagari, fonts.css,
                       load-fonts.js, licenses, README)
.opencode/             our custom agent + tools (tts / whisper / qcvision /
                       send_file — delivers files into the chat)
opencode.json          OpenCode providers (groq + nvidia), permissions
AGENTS.md              our standing instructions for the agent
deploy/                VPS setup.sh, systemd unit, go-live checklist,
                       fetch-core.sh (restore core/ at the pinned commit)
data/  store/          runtime state (state.json, pending.json, memory/
                       with preferences.md + index.md, inbox, outbox)
                       + stored masters (gitignored)
.env                   ALL configuration (never committed; see .env.example)
```

## Configuration

Everything lives in `.env` — copy `.env.example`, fill it in. It documents
every variable: bot token, owner id, Groq/NVIDIA keys and default models,
Whisper model, Edge TTS voice default, OpenCode binary/model/timeout,
Telegram size cap, public base URL, store port and retention. The bot is
**owner-only**: it ignores every Telegram user except `OWNER_TELEGRAM_ID`.
If jobs keep falling back or failing, run `node scripts/check-models.mjs`
to see which of your models are alive today.

## Local dev / tests

```bash
node --check bot/*.mjs media/*.mjs lib/*.mjs tests/*.mjs   # syntax
npm test        # smoke: SRT, model filtering, bitrate math, relay,
                # voice tools, model probes, TPM fallback, OpenCode
                # server-death/respawn, and the conversational flow
                # against a mock Telegram + mock OpenCode
npm start       # run the bot (needs a filled .env)
```

## Deploy (VPS) — the whole thing is three commands

### Create the Telegram bot (once)

1. In Telegram, open **@BotFather** and send `/newbot`.
2. Choose a **display name** (anything you like, e.g. "Drawn Videos").
3. Choose a **username** — it must end in `bot` (e.g. `my_drawn_videos_bot`).
4. BotFather replies with a **token**. Paste it when `setup-env.sh` asks
   for the bot token — **never share the token in a chat**: anyone who
   has it controls the bot.
5. Run the bot once (`bash run.sh` below) and it registers its own
   command menu — `/start`, `/new`, `/model`, `/cancel`, `/help` — with
   Telegram automatically. BotFather's `/setcommands` is **not** needed.

```bash
git clone https://github.com/ismdrobiul489-sudo/drawn-by-bot.git
cd drawn-by-bot
bash install.sh     # installs EVERYTHING: Node 20+, ffmpeg, Chromium,
                    # Edge TTS, OpenCode, the engine's npm dependency —
                    # and creates .env from the example. It never dies
                    # mid-way: it always ends with a ✓/✗ checklist (each
                    # ✗ with the exact manual fix) and only exits
                    # non-zero if a required tool is still missing.
bash setup-env.sh   # answer the questions one at a time — it writes
                    # .env for you (no text editor needed; phone-friendly)
bash run.sh         # preflight check + start the bot in this terminal
```

**Where it runs.** A normal VPS works, and so does **Google Cloud Shell
for testing** — Cloud Shell has no systemd, so `install.sh` skips the
service step there (with a printed note) and you run the bot with
`bash run.sh`. The systemd service further below exists only on hosts
that actually run systemd. Chromium falls back in order: apt package →
Playwright's chromium build (downloaded automatically; recorded as
`CHROME_PATH` in `.env`, which is the first place the engine looks).
OpenCode falls back from its official installer to
`npm install -g opencode-ai`. Edge TTS tries pip, then
`--break-system-packages`, then `--user`.

`.env` — what you must fill (everything else has working defaults):

| Variable | What it is |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token of the NEW bot from @BotFather |
| `OWNER_TELEGRAM_ID` | Your numeric Telegram id (the bot ignores everyone else) |
| `GROQ_API_KEY` | Your Groq key (jobs + Whisper) |
| `NVIDIA_API_KEY` | Your NVIDIA key (jobs + vision QC) |
| `PUBLIC_BASE_URL` | This server's public URL, so stored-video links open |

Prefer it always-on instead of a terminal? On a **systemd** host, after
`install.sh` and `.env`: `sudo systemctl enable --now drawn-by-bot`,
logs via `sudo journalctl -u drawn-by-bot -f`. (No systemd — e.g. Cloud
Shell — means no service; `bash run.sh` in a terminal is the way there.)
Full checklist in `deploy/README.md` — including the **Edge TTS smoke
test on the VPS first** (it was blocked from the dev VM's network; the
TTS is a swappable tool if a network blocks it).

## Honest status — what was NOT tested here

Development happened on a VM with **no real keys and no bot token**, so
these paths are written and unit/flow-tested but not live-fired:

- Real Telegram delivery (the conversational flow — plain-text turns,
  queueing, /new, /model, question buttons, voice intake, send_file
  delivery, TPM fallback, claims nudge, old-state migration — is
  verified against a mock Bot API server + a mock OpenCode server; the
  OpenCode server-death/respawn path is verified against a fake
  `opencode` binary that is really killed mid-conversation).
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
