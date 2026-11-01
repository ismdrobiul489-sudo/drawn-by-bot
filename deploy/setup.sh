#!/usr/bin/env bash
# drawn-by-bot — system setup (Ubuntu/Debian; run via install.sh, or
# directly as root / with sudo, from the repo root).
#
# Design rules (learned the hard way in Google Cloud Shell, 2026-11-01):
#  • NO `set -e`: a failing step must never abort the whole install —
#    every section reports and the script carries on to the end.
#  • The systemd unit step is BEST-EFFORT: on hosts without systemd
#    (Cloud Shell, containers) it prints how to run the bot instead
#    and is skipped — successfully.
#  • Every tool has a fallback chain and is verified by RUNNING it.
set -uo pipefail
cd "$(dirname "$0")/.."

FAILURES=0
note_fail() { FAILURES=$((FAILURES + 1)); echo "    ✗ $1"; }
note_ok() { echo "    ✓ $1"; }

SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi
export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$PATH"

# find_chromium — mirrors core/engine/browser.mjs findChrome():
#   $CHROME_PATH → $PLAYWRIGHT_BROWSERS_PATH (default /opt/pw-browsers)
#   → /usr/bin names. Plus ~/.cache/ms-playwright (Playwright's own
#   default download dir): the engine does NOT search there by itself,
#   so when that copy wins, install.sh records it as CHROME_PATH in .env
#   (which the engine checks FIRST) — see install.sh step 3.
find_chromium() {
  local c d
  if [ -n "${CHROME_PATH:-}" ] && [ -x "${CHROME_PATH:-}" ]; then echo "$CHROME_PATH"; return 0; fi
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
chromium_runnable() { local b; b="$(find_chromium)"; [ -n "$b" ] && "$b" --version >/dev/null 2>&1; }

echo "==> System packages: curl, git, ffmpeg, python3/pip"
$SUDO apt-get update || echo "    (apt-get update failed — continuing with whatever is installed)"
$SUDO apt-get install -y curl git ffmpeg python3-pip python3-venv || echo "    (some packages failed to install — the checklist at the end shows what is missing)"

echo "==> Node.js ≥ 20"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'parseInt(process.versions.node)' 2>/dev/null || echo 0)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO bash - || echo "    (nodesource setup failed)"
  $SUDO apt-get install -y nodejs || echo "    (nodejs install failed)"
fi
if command -v node >/dev/null 2>&1 && [ "$(node -p 'parseInt(process.versions.node)' 2>/dev/null || echo 0)" -ge 20 ]; then
  note_ok "node $(node --version)"
else
  note_fail "node ≥ 20 missing — fix: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - && sudo apt-get install -y nodejs"
fi

echo "==> ffmpeg"
if ffmpeg -version >/dev/null 2>&1; then note_ok "$(ffmpeg -version 2>/dev/null | head -1)"; else note_fail "ffmpeg missing — fix: sudo apt-get install -y ffmpeg"; fi

echo "==> Chromium (apt first, Playwright build as fallback)"
if ! chromium_runnable; then
  $SUDO apt-get install -y chromium 2>/dev/null || $SUDO apt-get install -y chromium-browser 2>/dev/null || echo "    (apt chromium unavailable — trying the Playwright build)"
fi
if ! chromium_runnable; then
  echo "    Downloading the Playwright chromium build (this can take a few minutes)…"
  timeout 600 npx -y playwright install chromium || echo "    (playwright download failed or timed out)"
fi
if chromium_runnable; then
  note_ok "chromium runnable: $(find_chromium)"
  echo "    The engine will use: $(find_chromium)"
else
  note_fail "no runnable chromium — fix: sudo apt-get install -y chromium, or: npx -y playwright install chromium"
fi

echo "==> Edge TTS (pip, with fallbacks)"
if ! edge-tts --help >/dev/null 2>&1; then
  pip3 install edge-tts 2>/dev/null || pip3 install --break-system-packages edge-tts 2>/dev/null || pip3 install --user edge-tts 2>/dev/null || echo "    (pip installs failed)"
  export PATH="$HOME/.local/bin:$PATH"
fi
if edge-tts --help >/dev/null 2>&1; then note_ok "edge-tts runs"; else note_fail "edge-tts missing — fix: pip3 install --break-system-packages edge-tts"; fi

echo "==> OpenCode (official installer, npm fallback)"
if ! opencode --version >/dev/null 2>&1; then
  curl -fsSL https://opencode.ai/install | bash || echo "    (official installer failed — trying npm)"
  export PATH="$HOME/.opencode/bin:$PATH"
fi
if ! opencode --version >/dev/null 2>&1; then
  npm install -g opencode-ai || echo "    (npm install -g opencode-ai failed)"
fi
if opencode --version >/dev/null 2>&1; then note_ok "opencode $(opencode --version 2>/dev/null | head -1)"; else note_fail "opencode missing — fix: curl -fsSL https://opencode.ai/install | bash (or: npm install -g opencode-ai)"; fi

echo "==> systemd unit (best-effort)"
if command -v systemctl >/dev/null 2>&1 && systemctl is-system-running >/dev/null 2>&1; then
  if $SUDO cp deploy/drawn-by-bot.service /etc/systemd/system/drawn-by-bot.service && $SUDO systemctl daemon-reload; then
    note_ok "systemd unit installed (enable with: sudo systemctl enable --now drawn-by-bot)"
  else
    echo "    ⚠ systemd is present but installing the unit failed — you can still run the bot with: bash run.sh"
  fi
else
  echo "    no systemd here — skipping service install; run with bash run.sh"
fi

if [ "$FAILURES" -gt 0 ]; then
  echo "==> setup.sh finished with $FAILURES missing tool(s) — see the ✗ lines above (install.sh's final checklist repeats them)."
  exit 1
fi
echo "==> setup.sh done — all system tools present."
