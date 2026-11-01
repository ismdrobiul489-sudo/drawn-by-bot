#!/usr/bin/env bash
# drawn-by-bot — Ubuntu VPS setup (run as root or with sudo, from the repo root).
set -euo pipefail

echo "==> System packages: node 20+, ffmpeg, chromium, python/pip, git, curl"
apt-get update
apt-get install -y curl git ffmpeg python3-pip python3-venv chromium-browser || apt-get install -y chromium
if ! command -v node >/dev/null || [ "$(node -p 'parseInt(process.versions.node)')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> Edge TTS (pip)"
pip3 install --break-system-packages edge-tts || pip3 install edge-tts

echo "==> OpenCode (official install script)"
if ! command -v opencode >/dev/null; then
  curl -fsSL https://opencode.ai/install | bash
  export PATH="$HOME/.opencode/bin:$PATH"
fi
opencode --version || true

echo "==> Project deps (none beyond Node builtins by design)"
node --version; ffmpeg -version | head -1

echo "==> systemd unit"
cp deploy/drawn-by-bot.service /etc/systemd/system/drawn-by-bot.service
systemctl daemon-reload

cat <<'EOF'

Setup done. Before enabling the service:
  1. cp .env.example .env  and fill in real values (bot token, owner id, keys, PUBLIC_BASE_URL)
  2. Smoke-test Edge TTS ON THIS VPS (it was blocked from the dev VM's network):
       edge-tts --voice en-US-AriaNeural --text "Hello, this is a test." --write-media /tmp/t.mp3 && ls -la /tmp/t.mp3
  3. systemctl enable --now drawn-by-bot
  4. journalctl -u drawn-by-bot -f   (watch the first /start)
EOF
