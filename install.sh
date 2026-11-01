#!/usr/bin/env bash
# drawn-by-bot — ONE-COMMAND INSTALL (Ubuntu VPS).
# Usage, right after cloning:
#     bash install.sh
# Installs everything the system needs: Node 20+, ffmpeg, Chromium,
# Edge TTS, OpenCode, the engine's npm dependency, and the systemd unit.
# Safe to re-run — every step skips what is already installed.
set -euo pipefail
cd "$(dirname "$0")"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
fi

echo "==> [1/4] System packages + tools (deploy/setup.sh)"
$SUDO bash deploy/setup.sh

echo "==> [2/4] Engine dependency (playwright-core, inside core/)"
(cd core && npm install --no-audit --no-fund)

echo "==> [3/4] Folders + .env"
mkdir -p data store
if [ ! -f .env ]; then
  cp .env.example .env
  echo "    Created .env from .env.example — you MUST fill it in (see below)."
else
  echo "    .env already exists, left untouched."
fi

echo "==> [4/4] Verifying the install"
node --version
ffmpeg -version 2>/dev/null | head -1
command -v chromium chromium-browser google-chrome google-chrome-stable 2>/dev/null | head -1 || echo "    WARNING: no Chromium found in a standard path — set CHROME_PATH in .env"
edge-tts --help >/dev/null 2>&1 && echo "edge-tts OK" || echo "    WARNING: edge-tts not on PATH"
export PATH="$HOME/.opencode/bin:$PATH"
opencode --version 2>/dev/null || echo "    WARNING: opencode not found"

cat <<'EOF'

──────────────────────────────────────────────────────────────
INSTALL DONE. Two things left:

  1. Fill in .env  (nano .env) — at minimum:
       TELEGRAM_BOT_TOKEN   (from @BotFather — a NEW bot)
       OWNER_TELEGRAM_ID    (your numeric Telegram id)
       GROQ_API_KEY
       NVIDIA_API_KEY
       PUBLIC_BASE_URL      (this server's public URL, for video links)

  2. Run it — pick ONE:
       bash run.sh                        ← run it yourself in this terminal
       sudo systemctl enable --now drawn-by-bot   ← run it forever as a service
       sudo journalctl -u drawn-by-bot -f         ← watch the service log

  First-run smoke test worth doing once:
       edge-tts --voice en-US-AriaNeural --text "Hello, this is a test." --write-media /tmp/t.mp3 && ls -la /tmp/t.mp3
──────────────────────────────────────────────────────────────
EOF
