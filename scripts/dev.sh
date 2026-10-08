#!/usr/bin/env bash
# dev.sh — one-command developer workflow for Privacy Vision Agent.
#
#   scripts/dev.sh            start the server (foreground)
#   scripts/dev.sh --eval     start server, run the SIH harness + browser smoke test
#   scripts/dev.sh --build    rebuild the browser-extension folders from the engine
#
# The server is pure Node (no npm install needed).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

node --check server/app/server.js
node --check server/app/planner.js

if [[ "${1:-}" == "--build" ]]; then
  scripts/build-extensions.sh
  exit 0
fi

if [[ "${1:-}" == "--eval" ]]; then
  node server/app/server.js &
  SERVER_PID=$!
  trap "kill $SERVER_PID 2>/dev/null || true" EXIT
  sleep 1.2
  echo "→ running SIH harness…"
  (cd harness && node eval.js)
  echo "→ running browser smoke test (Playwright)…"
  (cd harness && node browser-test.js)
  kill $SERVER_PID 2>/dev/null || true
  trap - EXIT
  exit 0
fi

echo
echo "  🛡  Privacy Vision Agent — local server"
echo "  ─────────────────────────────────────────"
echo "  Hub        http://127.0.0.1:8787/"
echo "  Banking    http://127.0.0.1:8787/demo/banking.html"
echo "  Flight     http://127.0.0.1:8787/demo/flight.html"
echo "  Login      http://127.0.0.1:8787/demo/login.html"
echo "  Face demo  http://127.0.0.1:8787/demo/face.html"
echo "  Eval page  http://127.0.0.1:8787/eval.html"
echo
echo "  LLM/VLM mode: set LLM_API_KEY / LLM_BASE_URL / LLM_MODEL to switch"
echo "  the planner from the offline fallback to an OpenAI-compatible model."
echo
exec node server/app/server.js
