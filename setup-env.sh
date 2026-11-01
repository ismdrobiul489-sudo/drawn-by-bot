#!/usr/bin/env bash
# drawn-by-bot — create/fill .env by ANSWERING QUESTIONS (mobile-friendly:
# no text editor needed — paste one value at a time and press Enter).
# Usage:
#     bash setup-env.sh
# It starts from .env.example (all defaults + explanations stay in the
# file), asks only for the values that are truly yours, and writes .env.
# Re-running is safe: existing values are kept when you just press Enter.
set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE=".env"
BASE=".env.example"
[ -f "$BASE" ] || { echo "Missing $BASE — run this from the repo root."; exit 1; }

# Current value of a key: from an existing .env, else from the example.
current() {
  local src="$BASE"
  [ -f "$ENV_FILE" ] && src="$ENV_FILE"
  grep -E "^$1=" "$src" 2>/dev/null | head -1 | cut -d= -f2- | tr -d ' \r'
}

# Ask one question; empty answer keeps the shown current value.
ask() {
  local key="$1" label="$2" secret="${3:-no}" cur ans shown
  cur="$(current "$key")"
  if [ -n "$cur" ]; then
    if [ "$secret" = "yes" ]; then shown="${cur:0:4}…"; else shown="$cur"; fi
    printf '%s [%s]: ' "$label" "$shown"
  else
    printf '%s: ' "$label"
  fi
  read -r ans || ans=""
  ans="$(printf '%s' "$ans" | tr -d ' \r')"
  [ -n "$ans" ] && VALUES["$key"]="$ans" || VALUES["$key"]="$cur"
}

declare -A VALUES

echo "── drawn-by-bot .env setup ─────────────────────────────"
echo "Paste each value and press Enter. Empty answer = keep what's shown."
echo ""
ask TELEGRAM_BOT_TOKEN "Telegram bot token (from @BotFather)" yes
ask OWNER_TELEGRAM_ID  "Your numeric Telegram user id"
ask GROQ_API_KEY       "Groq API key" yes
ask NVIDIA_API_KEY     "NVIDIA API key" yes
ask PUBLIC_BASE_URL    "Public base URL of this server (optional — Enter to skip, e.g. http://203.0.113.10:8090)"

# Build .env from the example, replacing exactly the asked keys.
tmp="$(mktemp)"
while IFS= read -r line; do
  replaced=0
  for key in "${!VALUES[@]}"; do
    case "$line" in
      "$key="*)
        printf '%s=%s\n' "$key" "${VALUES[$key]}" >> "$tmp"
        replaced=1
        break
        ;;
    esac
  done
  [ "$replaced" -eq 0 ] && printf '%s\n' "$line" >> "$tmp"
done < "$BASE"
mv "$tmp" "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo ""
missing=0
for key in TELEGRAM_BOT_TOKEN OWNER_TELEGRAM_ID GROQ_API_KEY NVIDIA_API_KEY; do
  if [ -z "$(grep -E "^$key=" "$ENV_FILE" | head -1 | cut -d= -f2-)" ]; then
    echo "  ✗ $key is still empty"
    missing=1
  fi
done
if [ "$missing" -eq 0 ]; then
  echo "✓ .env is ready (permissions 600 — only you can read it)."
  echo "  Next: bash run.sh"
else
  echo "Fill the missing ones by running bash setup-env.sh again."
  exit 1
fi
