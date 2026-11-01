#!/usr/bin/env bash
# drawn-by-bot — ONE-COMMAND RUN (after bash install.sh and filling in .env).
# Usage:
#     bash run.sh
# Checks the essentials first and tells you exactly what is missing,
# then starts the bot in this terminal (Ctrl+C stops it).
# For an always-on service instead: sudo systemctl enable --now drawn-by-bot
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.opencode/bin:$PATH"

fail=0
err() { echo "  ✗ $1"; fail=1; }
warn() { echo "  ! $1"; }

echo "==> Preflight"
if [ ! -f .env ]; then
  err ".env is missing — run: cp .env.example .env and fill it in"
else
  # Read values without executing the file.
  get() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | tr -d ' \r'; }
  [ -n "$(get TELEGRAM_BOT_TOKEN)" ] || err "TELEGRAM_BOT_TOKEN is empty in .env (get it from @BotFather)"
  [ -n "$(get OWNER_TELEGRAM_ID)" ] || err "OWNER_TELEGRAM_ID is empty in .env (your numeric Telegram id)"
  [ -n "$(get GROQ_API_KEY)" ] || warn "GROQ_API_KEY is empty — Groq jobs and Whisper will not work"
  [ -n "$(get NVIDIA_API_KEY)" ] || warn "NVIDIA_API_KEY is empty — NVIDIA jobs and vision QC will not work"
  [ -n "$(get PUBLIC_BASE_URL)" ] || warn "PUBLIC_BASE_URL is empty — stored-video links in Telegram will not open publicly"
fi

command -v node >/dev/null || err "node not found — run bash install.sh"
if command -v node >/dev/null && [ "$(node -p 'parseInt(process.versions.node)' 2>/dev/null || echo 0)" -lt 20 ]; then
  err "node 20+ required — run bash install.sh"
fi
command -v ffmpeg >/dev/null || err "ffmpeg not found — run bash install.sh"
command -v edge-tts >/dev/null || err "edge-tts not found — run bash install.sh"
command -v opencode >/dev/null || err "opencode not found — run bash install.sh"
if ! command -v chromium chromium-browser google-chrome google-chrome-stable >/dev/null 2>&1 \
   && [ ! -d "$HOME/.cache/ms-playwright" ] && [ -z "${CHROME_PATH:-}" ]; then
  warn "no Chromium spotted in a standard path — if renders fail, set CHROME_PATH in .env"
fi

if [ "$fail" -ne 0 ]; then
  echo "==> Fix the ✗ items above, then run bash run.sh again."
  exit 1
fi

echo "==> Starting drawn-by-bot (Ctrl+C to stop)"
exec node bot/bot.mjs
