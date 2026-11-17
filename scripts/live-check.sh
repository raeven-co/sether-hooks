#!/usr/bin/env bash
# Live check before a release: real Claude Code -> sether-hook gateway ->
# Anthropic's real API, on the cheapest model (a few cents).
#
# The model is asked to read a file and repeat values back. It only ever saw
# placeholders, so its reply must contain placeholders and none of the real
# (fictional) values. That proves the cleaned requests are accepted by the
# real API and that nothing sensitive reached the model.
#
# API key: an Anthropic API key (sk-ant-api...), never a plan login. Read from
# the macOS Keychain item "sether-anthropic" (or SETHER_LIVE_KEY). It is passed
# to Claude Code through apiKeyHelper and an environment variable only: never
# printed, written to a file or put on a command line.
#
#   security add-generic-password -a "$USER" -s sether-anthropic -w   # once; paste the key
#   npm run build && scripts/live-check.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# VS Code's debugger auto-attach hooks every Node process started in its
# terminal; keep it out of the gateway this script starts.
unset NODE_OPTIONS VSCODE_INSPECTOR_OPTIONS
PORT="${PORT:-18742}"
UPSTREAM="${SETHER_UPSTREAM:-https://api.anthropic.com}"

if [ -z "${SETHER_LIVE_KEY:-}" ]; then
  SETHER_LIVE_KEY="$(security find-generic-password -a "$USER" -s sether-anthropic -w 2>/dev/null || true)"
fi
if [ -z "$SETHER_LIVE_KEY" ]; then
  echo 'No API key found. Store one in the Keychain first (it asks for the key, hidden):'
  echo '  security add-generic-password -a "$USER" -s sether-anthropic -w'
  exit 1
fi
case "$SETHER_LIVE_KEY" in
  sk-ant-api*) ;;
  *) echo 'That is not an Anthropic API key (it should start with sk-ant-api).'; exit 1 ;;
esac
export SETHER_LIVE_KEY
command -v claude >/dev/null || { echo 'Claude Code (claude) is not on PATH.'; exit 1; }
[ -f "$ROOT/dist/cli.js" ] || { echo 'Build first: npm run build'; exit 1; }

WORK="$(mktemp -d)"
LOG="$WORK/gateway.log"
node "$ROOT/dist/cli.js" gateway --port "$PORT" --upstream "$UPSTREAM" >/dev/null 2>"$LOG" &
GATEWAY=$!
trap 'kill "$GATEWAY" 2>/dev/null || true; rm -rf "$WORK"' EXIT

for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$PORT/__sether/health" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -sf "http://127.0.0.1:$PORT/__sether/health" >/dev/null 2>&1 || {
  echo 'The gateway did not start:'
  cat "$LOG"
  exit 1
}

# Fictional values. The AWS-shaped key is built from parts so this file never
# holds a complete token.
AWS_KEY="AK""IA""Z3KXQ7M2""PL4RT8WN"
OWNER_EMAIL="tunde.bakare@northstar.dev"
OWNER_PHONE="+234 803 412 7789"
YOUR_EMAIL="ngozi.adeyemi@gmail.com"
printf 'Account owner: %s\nBackup phone: %s\n' "$OWNER_EMAIL" "$OWNER_PHONE" >"$WORK/contacts.txt"

echo "Gateway running on 127.0.0.1:$PORT -> $UPSTREAM. Asking Claude (Haiku)..."
cd "$WORK"
REPLY="$(
  # The prompt goes straight after -p: --allowedTools takes several values
  # and would swallow anything after it.
  ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" claude -p \
    "Read contacts.txt in this folder, then reply with exactly three short lines and nothing else: 1) the owner's email and phone as written in the file, 2) this key repeated exactly: $AWS_KEY 3) this email repeated exactly: $YOUR_EMAIL" \
    --model haiku \
    --settings '{"apiKeyHelper":"printf %s \"$SETHER_LIVE_KEY\""}' \
    --allowedTools Read \
    </dev/null 2>"$WORK/claude.err"
)" && STATUS=0 || STATUS=$?

echo
echo "What the model answered (it only ever saw placeholders):"
printf '%s\n' "$REPLY" | sed 's/^/  /'
if [ "$STATUS" -ne 0 ] || [ -s "$WORK/claude.err" ]; then
  echo
  echo "Claude Code exited with status $STATUS. Its messages:"
  grep -v 'connectors are disabled' "$WORK/claude.err" | sed 's/^/  /' || true
fi
echo
echo "Gateway log (counts and types only, never values):"
sed 's/^/  /' "$LOG"
echo

LEAKED=""
for value in "$AWS_KEY" "$OWNER_EMAIL" "$OWNER_PHONE" "$YOUR_EMAIL"; do
  case "$REPLY" in *"$value"*) LEAKED="yes" ;; esac
done
if [ -n "$LEAKED" ]; then
  echo 'FAIL: a real value came back from the model, so it reached the model.'
  exit 1
fi
if ! grep -q -- '-> 200, cleaned' "$LOG"; then
  echo 'FAIL: no request was cleaned and accepted. See the reply and the log above.'
  exit 1
fi
if ! printf '%s' "$REPLY" | grep -qE '\[(AWS_KEY|EMAIL|PHONE)_[0-9]+\]'; then
  echo 'CHECK: requests were cleaned and accepted, but the reply shows no placeholders. Read it above.'
  exit 1
fi
echo 'PASS: the real API accepted the cleaned requests, and the model saw placeholders only.'
