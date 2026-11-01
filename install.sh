#!/usr/bin/env bash
# drawn-by-bot — ONE-COMMAND INSTALL.
# Usage, right after cloning:
#     bash install.sh
# Installs everything the system needs: Node 20+, ffmpeg, Chromium,
# Edge TTS, OpenCode, the engine's npm dependency, and (only where
# systemd exists) the service unit. Works in Google Cloud Shell too —
# there is no systemd there, so the service step is skipped and the bot
# is run with `bash run.sh` instead.
#
# Design rule: this script NEVER dies silently mid-way. There is no
# `set -e`; every section reports, and the script ALWAYS reaches the
# final verification checklist, which prints ✓/✗ per tool with the
# exact manual fix for each ✗. Exit is non-zero only when a required
# tool is still missing AFTER all fallbacks.
set -uo pipefail
cd "$(dirname "$0")"

SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi
export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$PATH"

echo "==> [1/4] System packages + tools (deploy/setup.sh)"
$SUDO bash deploy/setup.sh || echo "    (setup.sh reported problems — continuing; the final checklist shows what is still missing)"

echo "==> [2/4] Engine dependency (playwright-core, inside core/)"
(cd core && npm install --no-audit --no-fund) || echo "    ⚠ npm install inside core/ failed — renders will not work until it succeeds; retry: (cd core && npm install)"

echo "==> [3/4] Folders + .env"
mkdir -p data store
if [ ! -f .env ]; then
  cp .env.example .env
  echo "    Created .env from .env.example — you MUST fill it in (bash setup-env.sh)."
else
  echo "    .env already exists, left untouched."
fi
# If the only runnable Chromium is a Playwright download (the engine does
# not search ~/.cache/ms-playwright by itself), record it as CHROME_PATH
# in .env — the engine checks CHROME_PATH first. Existing values win.
CHROME_BIN=""
for c in "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux/chrome "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux64/chrome; do
  [ -x "$c" ] && CHROME_BIN="$c" && break
done
if [ -n "$CHROME_BIN" ] && [ -f .env ] && ! grep -q '^CHROME_PATH=.' .env; then
  if grep -q '^CHROME_PATH=' .env; then
    sed -i "s|^CHROME_PATH=.*|CHROME_PATH=$CHROME_BIN|" .env
  else
    echo "CHROME_PATH=$CHROME_BIN" >> .env
  fi
  echo "    Recorded CHROME_PATH in .env (Playwright chromium): $CHROME_BIN"
fi

echo "==> [4/4] Final verification checklist"
MISSING=0
check() { # name, ok(0/1), fix text
  if [ "$2" -eq 0 ]; then echo "  ✓ $1"; else echo "  ✗ $1"; echo "      fix: $3"; MISSING=$((MISSING + 1)); fi
}

NODE_OK=1; command -v node >/dev/null 2>&1 && [ "$(node -p 'parseInt(process.versions.node)' 2>/dev/null || echo 0)" -ge 20 ] && NODE_OK=0
check "node ≥ 20 ($(node --version 2>/dev/null || echo missing))" "$NODE_OK" "curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - && sudo apt-get install -y nodejs"

FFMPEG_OK=1; ffmpeg -version >/dev/null 2>&1 && FFMPEG_OK=0
check "ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f1-3)" "$FFMPEG_OK" "sudo apt-get install -y ffmpeg"

# Chromium must actually RUN, not just exist: execute <bin> --version.
find_chromium() {
  local c d
  if [ -n "${CHROME_PATH:-}" ] && [ -x "${CHROME_PATH:-}" ]; then echo "$CHROME_PATH"; return 0; fi
  if [ -f .env ]; then
    local v; v="$(grep '^CHROME_PATH=' .env | head -1 | cut -d= -f2-)"
    [ -n "$v" ] && [ -x "$v" ] && { echo "$v"; return 0; }
  fi
  local pwb="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"
  for d in "$pwb"/chromium-*/; do
    for c in "$d"chrome-linux/chrome "$d"chrome-linux64/chrome; do
      [ -x "$c" ] && { echo "$c"; return 0; }
    done
  done
  for c in "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux/chrome "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux64/chrome; do
    [ -x "$c" ] && { echo "$c"; return 0; }
  done
  for c in /usr/bin/google-chrome-stable /usr/bin/google-chrome /usr/bin/chromium /usr/bin/chromium-browser; do
    [ -x "$c" ] && { echo "$c"; return 0; }
  done
  command -v chromium chromium-browser google-chrome google-chrome-stable 2>/dev/null | head -1
}
CHROME_BIN_FOUND="$(find_chromium)"
CHROME_OK=1; [ -n "$CHROME_BIN_FOUND" ] && "$CHROME_BIN_FOUND" --version >/dev/null 2>&1 && CHROME_OK=0
check "chromium (runnable) — the engine will use: ${CHROME_BIN_FOUND:-none found}" "$CHROME_OK" "sudo apt-get install -y chromium — or the Playwright build: npx -y playwright install chromium"

TTS_OK=1; edge-tts --help >/dev/null 2>&1 && TTS_OK=0
check "edge-tts" "$TTS_OK" "pip3 install --break-system-packages edge-tts (or: pip3 install --user edge-tts)"

OC_OK=1; opencode --version >/dev/null 2>&1 && OC_OK=0
check "opencode $(opencode --version 2>/dev/null | head -1)" "$OC_OK" "curl -fsSL https://opencode.ai/install | bash (or: npm install -g opencode-ai)"

echo
if [ "$MISSING" -gt 0 ]; then
  echo "INSTALL INCOMPLETE — $MISSING required tool(s) missing (fixes printed above). Fix them, then re-run: bash install.sh"
  exit 1
fi

HAS_SYSTEMD=0
if command -v systemctl >/dev/null 2>&1 && systemctl is-system-running >/dev/null 2>&1; then HAS_SYSTEMD=1; fi
cat <<EOF

──────────────────────────────────────────────────────────────
INSTALL DONE — every required tool verified above. Two things left:

  1. Fill in .env:  bash setup-env.sh  (answers a few questions — no
     editor needed). It needs: TELEGRAM_BOT_TOKEN (from @BotFather — a
     NEW bot), OWNER_TELEGRAM_ID, GROQ_API_KEY, NVIDIA_API_KEY,
     PUBLIC_BASE_URL (this server's public URL, for video links).

  2. Run it — pick ONE:
       bash run.sh                        ← run it yourself in this terminal
EOF
if [ "$HAS_SYSTEMD" -eq 1 ]; then
  cat <<'EOF'
       sudo systemctl enable --now drawn-by-bot   ← run it forever as a service
       sudo journalctl -u drawn-by-bot -f         ← watch the service log
EOF
else
  cat <<'EOF'
       (no systemd on this machine, so no service option — run.sh is the way;
        on a systemd VPS the service option appears here)
EOF
fi
cat <<'EOF'

  First-run smoke test worth doing once:
       edge-tts --voice en-US-AriaNeural --text "Hello, this is a test." --write-media /tmp/t.mp3 && ls -la /tmp/t.mp3
──────────────────────────────────────────────────────────────
EOF
