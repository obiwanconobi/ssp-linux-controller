#!/usr/bin/env bash
# Password/token smoke: deterministic password-protected simulator -> CLI.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-45692}"
SIM="$ROOT/target/debug/stomp-sim"
CLI="$ROOT/target/debug/stomp"
TMP="$(mktemp -d)"
trap '[[ -n "${SIM_PID:-}" ]] && kill "$SIM_PID" 2>/dev/null || true; rm -rf "$TMP"' EXIT

echo "== build =="
cargo build -p stomp-sim -p stomp-cli

echo "== start password-protected simulator on $PORT =="
"$SIM" --port "$PORT" --password 12345678 >"$TMP/sim.log" 2>&1 &
SIM_PID=$!
sleep 0.6
if ! kill -0 "$SIM_PID" 2>/dev/null; then
  echo "simulator failed to start"
  cat "$TMP/sim.log"
  exit 1
fi
ADDR="tcp:127.0.0.1:$PORT"

echo "== reads work without a password =="
"$CLI" dump "$ADDR" >"$TMP/snapshot.json" 2>"$TMP/dump.log"
python3 - "$TMP/snapshot.json" <<'PY'
import json, sys
snapshot = json.load(open(sys.argv[1]))
assert snapshot["connected"] is True, "read-only connection should work"
print("read-only assertion passed")
PY

echo "== writes are rejected without a password =="
if "$CLI" set-block "$ADDR" 'root\app\gate' on >"$TMP/no-password.json" 2>"$TMP/no-password.log"; then
  echo "write without a password was accepted"
  exit 1
fi
grep -qi "password" "$TMP/no-password.log"
echo "password-required assertion passed"

echo "== a wrong password is reported clearly =="
if "$CLI" --password wrong-password set-block "$ADDR" 'root\app\gate' on >"$TMP/wrong.json" 2>"$TMP/wrong.log"; then
  echo "wrong password was accepted"
  exit 1
fi
grep -qi "rejected\|password" "$TMP/wrong.log"
echo "wrong-password assertion passed"

echo "== the correct password writes =="
"$CLI" --password 12345678 set-block "$ADDR" 'root\app\gate' on >"$TMP/with-password.json" 2>"$TMP/with-password.log"
python3 - "$TMP/with-password.json" <<'PY'
import json, sys
snapshot = json.load(open(sys.argv[1]))
gate = next(block for block in snapshot["chain"]["blocks"] if block["label"] == "Noise Gate")
assert gate["on"] is True, gate
print("authenticated write assertion passed")
PY

echo "== the correct password uploads =="
python3 - "$TMP/test.nam" <<'PY'
import json, sys
json.dump({
    "version": "0.5.4",
    "architecture": "WaveNet",
    "config": {"layers": [], "head": None, "head_scale": 0.02},
    "weights": [0.0, 0.1],
    "sample_rate": 48000,
    "metadata": {"name": "Auth Smoke", "gear_type": "amp"},
}, open(sys.argv[1], "w"))
PY
"$CLI" --password 12345678 upload "$ADDR" nam "$TMP/test.nam" 2 'root\nam_amp' >"$TMP/upload.json" 2>"$TMP/upload.log"
python3 - "$TMP/upload.json" <<'PY'
import json, sys
result = json.load(open(sys.argv[1]))
assert result["slot"] == 2, result
assert result["name"] == "Auth Smoke", result
assert result["chunks"] > 1, result
print("authenticated upload assertion passed")
PY

echo "== authenticated download =="
"$CLI" --password 12345678 download-list-item "$ADDR" 'root\nam_amp' 2 "$TMP/downloaded.nam" >"$TMP/download.json" 2>"$TMP/download.log"
python3 - "$TMP/download.json" "$TMP/downloaded.nam" <<'PY'
import json, os, sys
result = json.load(open(sys.argv[1]))
assert result["name"] == "Auth Smoke", result
assert result["index"] == 2, result
assert os.path.getsize(sys.argv[2]) > 0
print("authenticated download assertion passed")
PY

echo
echo "AUTH SMOKE PASSED"
