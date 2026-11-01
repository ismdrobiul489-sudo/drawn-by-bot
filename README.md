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
first** and sends it to the chat — you reply in plain language ("রংটা বদলাও",
"এই জায়গাটা ফাঁকা"), the bot forwards your words into the **same OpenCode
session**, and it revises. When you're happy you press **✅ Final render**.
The finished master is stored and its **public backup link** travels with
the Telegram video (which is bitrate-capped to fit Telegram's bot limit
when needed). No duration limit: long videos are chunked underneath
(TTS by sentence, Whisper by 10-minute chunks, scenes by SRT segment) and
delivered by store link when they outgrow Telegram.

## Repo layout

```
core/                  upstream drawn-by-code, UNMODIFIED (see UPSTREAM.md)
bot/                   Telegram bot: telegram.mjs (API client), bot.mjs (flow),
                       models.mjs (dynamic model lists), styles.mjs, queue.mjs
                       (one active job), processor.mjs (OpenCode driver)
media/                 tts.mjs (Edge TTS), whisper.mjs (Groq Whisper → SRT),
                       srt.mjs, qc-vision.mjs (NVIDIA vision QC),
                       encode.mjs (Telegram fit), store.mjs (public links)
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

## Deploy (VPS)

`bash deploy/setup.sh`, then follow `deploy/README.md` — BotFather bot,
keys, **Edge TTS smoke test on the VPS first** (it was blocked from the dev
VM's network; the TTS is a swappable tool if a network blocks it), systemd
enable, store link check.

## Honest status — what was NOT tested here

Development happened on a VM with **no real keys and no bot token**, so
these paths are written and unit/flow-tested but not live-fired:

- Real Telegram delivery (flow verified against a mock Bot API server).
- OpenCode actually driving a job end-to-end with a real Groq/NVIDIA key
  (OpenCode 1.19.5 itself was installed and its provider config verified
  here: `opencode models` lists both providers; sessions need keys).
- Edge TTS synthesis from this machine (its network blocks the endpoint —
  a known, documented issue; test on the VPS per the checklist).
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
