# Deploying drawn-by-bot on the VPS

Development happens on the dev machine; the user uploads this repo to GitHub
himself and clones it on the VPS. The VPS is the runtime: bot + OpenCode +
the engine's Chromium/ffmpeg renders all live there (the dev VM and free-tier
micro VMs are too small for Chromium + ffmpeg rendering).

## Go-live checklist

1. **New Telegram bot.** In @BotFather: `/newbot`, save the token. Do NOT
   reuse any existing bot — a bot token can only be polled by one process,
   and the user's other bot already belongs to another AI.
2. **Your Telegram id.** Message @userinfobot (or similar) and note your
   numeric id → `OWNER_TELEGRAM_ID`. The bot ignores everyone else.
3. **API keys.** Groq (console.groq.com) and NVIDIA (build.nvidia.com) keys
   go into `.env` on the VPS only. `cp .env.example .env` and fill it in.
4. **Public URL.** Point a domain/subdomain (or the VPS IP) at the store
   port and set `PUBLIC_BASE_URL` — stored masters are linked as
   `PUBLIC_BASE_URL/files/<token>/<file>`.
5. **Install:** `bash deploy/setup.sh` (Node 20+, ffmpeg, Chromium,
   edge-tts, OpenCode, systemd unit).
6. **⚠️ Edge TTS smoke test ON THE VPS, before anything else:**
   `edge-tts --voice en-US-AriaNeural --text "Hello, this is a test." --write-media /tmp/t.mp3`
   then check the file is non-empty and plays. Edge TTS was **blocked from
   the dev VM's network** (SSL errors, 0-byte files) — that was that VM's
   egress, but if the VPS is blocked too, swap the TTS tool (media/tts.mjs)
   for Piper/Orpheus — TTS is a tool precisely so nothing else changes.
7. **OpenCode check:** `opencode --version`, then in the repo:
   `opencode models` should list the groq and nvidia providers from
   `opencode.json` once keys are in `.env`.
8. **Enable:** `systemctl enable --now drawn-by-bot`, watch
   `journalctl -u drawn-by-bot -f`, send `/start` to the bot.
9. **First job:** pick style `line` or `paper-cutout`, 9:16, a short topic.
   Expect the animatic first; reply with feedback in chat, then press
   ✅ Final render.
10. **Store check:** the delivered message must contain a working backup
    link. Open it from your phone (mobile data, not the VPS network).

## Notes

- One job runs at a time by design (FIFO queue) — NVIDIA's per-model worker
  limit punishes parallel calls, and one VPS renders one video well.
- Long videos are allowed; render time and file size grow with duration.
  Over-size masters are delivered by store link; Telegram gets a
  bitrate-capped copy.
- If the bot ever needs >50 MB uploads into Telegram, run a self-hosted
  `telegram-bot-api` server and set `TELEGRAM_API_BASE` to it (2 GB limit).
