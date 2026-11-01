# drawn-by-bot — project instructions

A Telegram bot that turns a chat conversation into a finished drawn
video. The owner talks to ONE persistent OpenCode agent exactly like a
chatbot (no forms, no job queue): he sends a topic, a full script, or a
voice message with his own recorded narration; the agent writes,
narrates, draws and renders with the drawnbycode engine, asks him
questions as buttons when something material is missing, and delivers
previews and finished videos back into the same chat.

## UPSTREAM RULE — read first

**NONE of the original files of https://github.com/illodev/drawn-by-code
may be modified.** The upstream project is imported under `core/`
(renamed only, content untouched, commit
`3c9c949421e4aa86dba444dfe8cba46d000f9d87`). Everything we add lives in
our own new files around it (`bot/`, `media/`, `.opencode/`, `deploy/`).
If upstream behaviour needs changing, wrap it or configure it from
outside — never edit `core/`. Verify with
`git status --porcelain core` (must be empty) after any work session.

## How the conversation works

- `bot/bot.mjs` is the front end: owner-only lock, commands, attachment
  intake, and routing. Plain text from the owner IS a conversation turn.
- `bot/conversation.mjs` owns the session: an OpenCode session per chat
  (serve driver, `bot/agent-server.mjs`), session working directory =
  the REPO ROOT, sessionId persisted in `data/state.json` and resumed
  after restarts. The agent's streamed text is forwarded to Telegram as
  chat messages. Messages sent while a turn runs are queued and
  delivered as the next turn.
- **Session lifecycle (owner's rule): a session is the lifetime of ONE
  job** — it opens with a request, carries that video's revisions, and
  ENDS when the finished video is delivered (a `send_file` request with
  `final: true` → the watcher rotates: the sessionId is archived into
  the chat's `pastSessions` list and the next message opens a FRESH
  session). `/new` is the manual rotation. A session with no final
  delivery simply stays open.
- **Agent memory lives in `data/memory/`** (created if absent):
  `preferences.md` = the core only (standing preferences, his
  language/behaviour notes, proven rules); `index.md` = ONE line per
  finished video (date — title — job folder), nothing more. The agent
  maintains both (index append + preference folding at final delivery;
  preference updates the moment one is stated, edited in place on
  revision). When the bridge creates a NEW session it prepends a
  compact brief — full preferences + last ~10 index lines, ~4000 chars
  — to the first prompt. Continuity comes from these files, never from
  session length.
- Commands are the only rigid parts: `/start` (status), `/new` (fresh
  session), `/model` (switch the standing model), `/cancel` (abort the
  running turn / clear the queue), `/help`.
- The agent's method lives in `.opencode/agent/video-maker.md`:
  conversational tone in the owner's language, ask-don't-interrogate,
  per-video folders under `core/sandbox/<job>/` with their own
  `brief.md`, previews + finals delivered via the `send_file` tool
  (`final: true` only for the finished video).
- **Delivery bridge:** OpenCode tools run in the server process (no
  Telegram token), so `send_file` writes a JSON request into
  `data/outbox/` and `bot/outbox.mjs` performs the real send (video cap
  from `TELEGRAM_MAX_MB`, store-link fallback for oversize masters).
- **Claims check:** if a turn's text claims a file was sent/rendered but
  no send_file request arrived during that turn, the bridge sends ONE
  automatic nudge turn demanding the actual send or a plain explanation.
  Never weaken this without the owner's word — it exists because a run
  once "finished" with no video and a pointer to a review file that did
  not exist.

## Input modes (the agent judges from context — there is no form)

1. **Topic** → the agent writes the script, synthesises narration with
   Edge TTS (project `tts` tool), draws and renders.
2. **Script** → the owner's exact words, narrated as-is.
3. **Voice script** → the owner records the FULL narration himself. The
   bot auto-transcribes the voice/audio message (Groq Whisper) and
   forwards transcript + audio path; the transcript IS the script
   (scene timing from it) and HIS audio is the narration track — no
   script generation, no TTS. (Owner's correction: this is a "voice
   script", never a casual "voice note".)

## Voice rules (standing orders)

- **Never time-stretch TTS.** Synthesis at speed 100; the inter-sentence
  pause (0.30s) is added as silence between chunks by the `tts` tool.
- TTS narration is SECTIONED (hook/body/outro) and can take pitch-varied
  takes (`TTS_TAKES`); selection happens at synthesis, never by
  post-processing speed.
- Voice QC is the AGENT's own loop step: `node media/qc-audio.mjs
  <job-folder>` — silence gaps, clipping, quota-guarded Whisper
  word-check; flagged sections are regenerated once, then re-checked.
- Numbers/currency/percent are verbalised before synthesis
  (`media/prep.mjs`), including Bengali digits → words in Bengali text.

## Providers & models — standing selection, never asked per turn

- Both providers stay: **Groq** and **NVIDIA**. Model lists are ALWAYS
  fetched live from each provider's `/models` endpoint — never hardcode
  a model list anywhere.
- **The standing selection lives in the chat state** (`data/state.json`,
  initialised from `.env`: `DEFAULT_PROVIDER` + per-provider
  `*_DEFAULT_MODEL`). It is used silently by every turn. **Neither the
  bot nor the agent asks the owner anything about providers/models
  unprompted.**
- The selection changes ONLY via the owner's `/model` command (provider
  buttons → live model buttons; the current one is marked ⭐) or via an
  automatic guard switch (below), and persists until changed again.
- **Fallback guard (owner's rule):** a dead model must never mean
  silence. Before the FIRST turn of a new session, the standing model is
  probed (1-token API call, `bot/conversation.mjs` `ensureWorkingModel`);
  if it does not answer, the chain is: same provider's `.env` default →
  the other provider's `.env` default. On a turn that fails with a
  token-limit (TPM) error, the other provider's default is probed and
  the turn retried once. Every automatic switch posts a PERSISTENT
  Telegram notice (never the rolling status message — those get
  overwritten and the owner never sees them) and saves the new standing
  selection. If nothing answers, the owner gets a loud, named failure
  message (what was tried, what to check) — as a normal chat message,
  never a silent dead end. `MODEL_PROBE=off` disables probing.
  `node scripts/check-models.mjs` lists which models answer right now.
- Known platform fact (2026-11-01): Groq FREE tier caps
  `openai/gpt-oss-120b` at 8,000 tokens/min and a fresh session's first
  turn is ~10.7k tokens — a Groq free model can never pass a first turn;
  the TPM fallback exists for exactly this. NVIDIA on this key: some
  listed models 404 ("Function … not found for account") or hang — the
  probe treats both as dead.

## Error handling (owner's standing demand)

- Telegram polling retries network errors/timeouts/409s with backoff
  and logs them; it must never crash or silently stop. `bot.mjs`
  installs unhandledRejection/uncaughtException guards that log and
  keep the process alive.
- If the OpenCode server process dies, `agent-server` respawns it; the
  bridge re-attaches to the persisted session and the owner gets ONE
  notice: "Agent restarted — our conversation is intact."
- Every owner-visible failure message is plain language, names the
  cause, and never points to files that don't exist.

## Fonts

Bengali and Hindi (Devanagari) scene text: Noto Sans Bengali +
Devanagari woff2 live in `assets/fonts/`. The engine's internal server
serves only `core/`, so the agent copies the needed font files into the
job's sandbox folder and lists them in the scene's `fonts:` array.

## Config & secrets

- Everything lives in `.env` (see `.env.example`): bot token, owner id,
  provider keys, standing defaults, ports. Real `.env` is gitignored —
  never commit it, never print secrets, never ask the owner to paste
  keys into chat (he enters them on the server via `setup-env.sh`).
- Bot UI language: ALL ENGLISH (commands, notices, buttons). The
  agent's own chat replies follow the owner's language — that is the
  agent's instruction, not bot text.

## Run

```bash
bash install.sh     # deps + tools (best-effort systemd; safe without it)
bash setup-env.sh   # interactive .env (asks one value at a time)
bash run.sh         # foreground (preflight-checks everything first)
sudo systemctl enable --now drawn-by-bot   # service, systemd hosts only
npm test            # full test suite (mock Telegram + mock OpenCode)
```
