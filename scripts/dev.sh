#!/usr/bin/env bash
# Start Vite + the Tauri desktop shell in development mode.
#
#   ./scripts/dev.sh          # auto-discover Wi-Fi, then USB
#   ./scripts/dev.sh --demo   # force the demo board (no hardware search)
#   ./scripts/dev.sh --sim    # also start the deterministic simulator on 45678
#
# A debug Tauri build loads http://127.0.0.1:1420, so Vite must stay running.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UI="$ROOT/apps/desktop/ui"
WITH_SIM=0
WITH_DEMO=0
for argument in "$@"; do
  case "$argument" in
    --sim) WITH_SIM=1 ;;
    --demo) WITH_DEMO=1 ;;
  esac
done

# pnpm may be installed per-user rather than system-wide.
if ! command -v pnpm >/dev/null 2>&1; then
  export PATH="$HOME/.local/share/pnpm/bin:$PATH"
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm was not found. Install it with: curl -fsSL https://get.pnpm.io/install.sh | sh -" >&2
  exit 1
fi

kill_tree() {
  local pid="$1"
  [[ -z "$pid" ]] && return 0
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

cleanup() {
  trap - EXIT INT TERM
  kill_tree "${TAURI_PID:-}"
  kill_tree "${VITE_PID:-}"
  kill_tree "${SIM_PID:-}"
}
trap cleanup EXIT INT TERM

if [[ ! -d "$UI/node_modules" ]]; then
  echo "== installing UI dependencies =="
  (cd "$UI" && pnpm install)
fi

if [[ "$WITH_SIM" == "1" ]]; then
  echo "== starting simulator on tcp://127.0.0.1:45678 =="
  (cd "$ROOT" && cargo run -p stomp-sim -- --port 45678) &
  SIM_PID=$!
fi

echo "== starting Vite on http://127.0.0.1:1420 =="
(cd "$UI" && pnpm dev) &
VITE_PID=$!

# Wait for the dev server before the webview loads it.
for _ in $(seq 1 80); do
  if curl -fsS http://127.0.0.1:1420/ >/dev/null 2>&1; then
    break
  fi
  sleep 0.15
done
if ! curl -fsS http://127.0.0.1:1420/ >/dev/null 2>&1; then
  echo "Vite did not come up on 127.0.0.1:1420." >&2
  exit 1
fi

echo "== starting StompStation (debug) =="
if [[ "$WITH_DEMO" == "1" ]]; then
  export STOMPSTATION_DEMO=1
  echo "    Launch flag: demo simulator only."
else
  echo "    Startup: Wi-Fi discovery, then USB; a connection sheet appears if none is found."
fi
if [[ "$WITH_SIM" == "1" ]]; then
  echo "    TCP simulator is available at 127.0.0.1:45678."
fi
cd "$ROOT"
cargo run -p stompstation-desktop &
TAURI_PID=$!
wait "$TAURI_PID"
