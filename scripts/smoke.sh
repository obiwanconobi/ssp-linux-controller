#!/usr/bin/env bash
# Phase 0/1 smoke: deterministic simulator -> headless Rust core -> assertions.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-45681}"
SIM="$ROOT/target/debug/stomp-sim"
CLI="$ROOT/target/debug/stomp"
TMP="$(mktemp -d)"
trap '[[ -n "${SIM_PID:-}" ]] && kill "$SIM_PID" 2>/dev/null || true; rm -rf "$TMP"' EXIT

echo "== build =="
cargo build -p stomp-sim -p stomp-cli

echo "== start simulator on $PORT =="
"$SIM" --port "$PORT" >"$TMP/sim.log" 2>&1 &
SIM_PID=$!
sleep 0.6

echo "== choose a free port if needed =="
if ! kill -0 "$SIM_PID" 2>/dev/null; then
  echo "simulator failed to start"
  cat "$TMP/sim.log"
  exit 1
fi

ADDR="tcp:127.0.0.1:$PORT"

echo "== dump snapshot =="
"$CLI" dump "$ADDR" >"$TMP/snapshot.json" 2>"$TMP/dump.log"
cat "$TMP/dump.log"

python3 - "$TMP/snapshot.json" <<'PY'
import json, sys
snapshot = json.load(open(sys.argv[1]))
assert snapshot["connected"] is True, "snapshot is not connected"
assert snapshot["device_name"] == "StompStation PRO", snapshot["device_name"]
assert snapshot["firmware"] == "2.4.4", snapshot["firmware"]
assert snapshot["preset"]["current"] == "Match Brave Chorus", snapshot["preset"]["current"]
assert len(snapshot["preset"]["names"]) == 52, len(snapshot["preset"]["names"])
assert [block["label"] for block in snapshot["chain"]["blocks"]] == [
    "Noise Gate", "Pitch", "Compressor", "Drive / Distortion", "Amp (NAM)",
    "IR / Cabinet", "Modulation (post)", "Delay", "Reverb",
]
amp_slot = next(slot for slot in snapshot["chain"]["slots"] if slot["label"] == "Amp (NAM)")
assert amp_slot["fixed"] is True, "amp should be a fixed slot"
assert len(snapshot["eq"]["bands"]) == 4, len(snapshot["eq"]["bands"])
assert len(snapshot["lists"]) == 4, len(snapshot["lists"])
print("snapshot assertions passed")
PY

echo "== remove / add / replace chain blocks =="
"$CLI" remove-block "$ADDR" 0 2 >"$TMP/remove.json" 2>"$TMP/remove.log"
python3 - "$TMP/remove.json" <<'PY'
import json, sys
snapshot = json.load(open(sys.argv[1]))
labels = [block["label"] for block in snapshot["chain"]["blocks"]]
assert labels == ["Noise Gate", "Compressor", "Drive / Distortion", "Amp (NAM)",
                  "IR / Cabinet", "Modulation (post)", "Delay", "Reverb"], labels
assert any(slot["row"] == 0 and slot["col"] == 2 and not slot["path"]
           for slot in snapshot["chain"]["slots"])
assert any(block["name"] == "Pitch" for block in snapshot["chain"]["available_blocks"])
print("chain remove assertion passed")
PY

"$CLI" add-block "$ADDR" 0 2 'root\app\pitch' >"$TMP/add.json" 2>"$TMP/add.log"
python3 - "$TMP/add.json" <<'PY'
import json, sys
snapshot = json.load(open(sys.argv[1]))
labels = [block["label"] for block in snapshot["chain"]["blocks"]]
assert labels == ["Noise Gate", "Pitch", "Compressor", "Drive / Distortion", "Amp (NAM)",
                  "IR / Cabinet", "Modulation (post)", "Delay", "Reverb"], labels
print("chain add assertion passed")
PY

"$CLI" replace-block "$ADDR" 0 0 'root\app\chorus' >"$TMP/replace.json" 2>"$TMP/replace.log"
python3 - "$TMP/replace.json" <<'PY'
import json, sys
snapshot = json.load(open(sys.argv[1]))
labels = [block["label"] for block in snapshot["chain"]["blocks"]]
assert labels[0] == "Chorus", labels
assert any(block["name"] == "Noise Gate" for block in snapshot["chain"]["available_blocks"])
print("chain replace assertion passed")
PY

"$CLI" replace-block "$ADDR" 0 0 'root\app\gate' >"$TMP/replace-back.json" 2>"$TMP/replace-back.log"
python3 - "$TMP/replace-back.json" <<'PY'
import json, sys
snapshot = json.load(open(sys.argv[1]))
labels = [block["label"] for block in snapshot["chain"]["blocks"]]
assert labels[0] == "Noise Gate", labels
print("chain replace-back assertion passed")
PY

echo "== bypass the amp =="
"$CLI" set-block "$ADDR" 'root\app\amp' off >"$TMP/toggle.json" 2>"$TMP/toggle.log"
python3 - "$TMP/toggle.json" <<'PY'
import json, sys
snapshot = json.load(open(sys.argv[1]))
amp = next(block for block in snapshot["chain"]["blocks"] if block["label"] == "Amp (NAM)")
assert amp["on"] is False, amp
print("block toggle assertion passed")
PY

echo "== load a preset =="
"$CLI" preset "$ADDR" "Dumble Clean" >"$TMP/preset.json" 2>"$TMP/preset.log"
python3 - "$TMP/preset.json" <<'PY'
import json, sys
snapshot = json.load(open(sys.argv[1]))
assert snapshot["preset"]["current"] == "Dumble Clean", snapshot["preset"]["current"]
print("preset assertion passed")
PY

echo "== upload a small A1 NAM =="
python3 - "$TMP/test.nam" <<'PY'
import json, sys
json.dump({"version": "0.5.4", "architecture": "WaveNet",
           "config": {"layers": [], "head": None, "head_scale": 0.02},
           "weights": [0.0, 0.1], "sample_rate": 48000,
           "metadata": {"name": "Smoke Test", "gear_type": "amp"}},
          open(sys.argv[1], "w"))
PY
"$CLI" upload "$ADDR" nam "$TMP/test.nam" 2 'root\nam_amp' >"$TMP/upload.json" 2>"$TMP/upload.log"
python3 - "$TMP/upload.json" <<'PY'
import json, sys
result = json.load(open(sys.argv[1]))
assert result["target"] == r"root\nam_amp", result
assert result["slot"] == 2, result
assert result["name"] == "Smoke Test", result
assert result["chunks"] > 1, result
print("A1 NAM upload assertion passed")
PY

echo "== upload a small A2 NAM =="
python3 - "$TMP/test-a2.nam" <<'PY'
import json, sys
child = {"version": "0.7.0", "architecture": "WaveNet", "config": {},
         "weights": [0.1, 0.2], "sample_rate": 48000}
json.dump({"version": "0.7.0", "architecture": "SlimmableContainer",
           "config": {"submodels": [
               {"max_value": 0.5, "model": child},
               {"max_value": 1, "model": child},
           ]},
           "weights": [], "sample_rate": 48000,
           "metadata": {"name": "Smoke A2", "gear_type": "amp"}},
          open(sys.argv[1], "w"))
PY
"$CLI" upload "$ADDR" nam "$TMP/test-a2.nam" 3 'root\nam_amp' >"$TMP/upload-a2.json" 2>"$TMP/upload-a2.log"
python3 - "$TMP/upload-a2.json" <<'PY'
import json, sys
result = json.load(open(sys.argv[1]))
assert result["target"] == r"root\nam_amp", result
assert result["slot"] == 3, result
assert result["name"] == "Smoke A2", result
assert result["chunks"] > 1, result
print("A2 NAM upload assertion passed")
PY

echo "== upload a small PNAM =="
python3 - "$TMP/test.pnam" <<'PY'
import json, sys
json.dump({"version": "0.5.4", "architecture": "ParametricSlimmableContainer",
           "config": {}, "weights": [0.0, 0.1], "sample_rate": 48000,
           "metadata": {"name": "Smoke PNAM", "gear_type": "amp"}},
          open(sys.argv[1], "w"))
PY
"$CLI" upload "$ADDR" pnam "$TMP/test.pnam" 2 'root\pnam_list' >"$TMP/pnam-upload.json" 2>"$TMP/pnam-upload.log"
python3 - "$TMP/pnam-upload.json" <<'PY'
import json, sys
result = json.load(open(sys.argv[1]))
assert result["target"] == r"root\pnam_list", result
assert result["slot"] == 2, result
assert result["name"] == "Smoke PNAM", result
assert result["chunks"] > 1, result
print("PNAM upload assertion passed")
PY

echo "== reject a stub NAM before any bytes =="
cat >"$TMP/stub.nam" <<'JSON'
{"version": "0.5.4", "architecture": "WaveNet", "config": {}, "weights": []}
JSON
if "$CLI" upload "$ADDR" nam "$TMP/stub.nam" 2 'root\nam_amp' >"$TMP/stub.json" 2>"$TMP/stub.log"; then
  echo "stub NAM was accepted"
  exit 1
fi
if ! grep -q "no weights" "$TMP/stub.log"; then
  cat "$TMP/stub.log"
  exit 1
fi
echo "stub NAM assertion passed"

echo "== reject a wrong-kind upload target =="
if "$CLI" upload "$ADDR" nam "$TMP/test.nam" 2 'root\ir_list' >"$TMP/wrong-kind.json" 2>"$TMP/wrong-kind.log"; then
  echo "NAM was accepted by an IR list"
  exit 1
fi
if ! grep -q "expected capture list type nam" "$TMP/wrong-kind.log"; then
  cat "$TMP/wrong-kind.log"
  exit 1
fi
echo "wrong-kind target assertion passed"

echo "== upload an IR WAV larger than the decoded slot =="
python3 - "$TMP/cab.wav" <<'PY'
import sys, wave
with wave.open(sys.argv[1], "wb") as wav:
    wav.setnchannels(1)
    wav.setsampwidth(2)
    wav.setframerate(48000)
    wav.writeframes(b"\x00\x00" * 5000)
PY
"$CLI" upload "$ADDR" ir "$TMP/cab.wav" 3 'root\ir_list' >"$TMP/ir-upload.json" 2>"$TMP/ir-upload.log"
python3 - "$TMP/ir-upload.json" "$TMP/cab.wav" <<'PY'
import json, os, sys
result = json.load(open(sys.argv[1]))
assert result["target"] == r"root\ir_list", result
assert result["slot"] == 3, result
assert result["name"] == "cab", result
assert result["payload_bytes"] == 2048 * 4, result
assert os.path.getsize(sys.argv[2]) > 2048 * 4, "test WAV should exceed the decoded slot"
print("IR upload assertion passed")
PY

echo "== fixture generation =="
"$CLI" fixture "$ADDR" "$TMP/fixture.json" 2>"$TMP/fixture.log"
python3 - "$TMP/fixture.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
assert len(data["snapshot"]["chain"]["blocks"]) == 9
assert len(data["editors"]) == 9
assert "root\\app\\amp" in data["editors"]
print("fixture assertion passed")
PY

echo "== clear the signal chain =="
"$CLI" clear-chain "$ADDR" >"$TMP/clear-chain.json" 2>"$TMP/clear-chain.log"
python3 - "$TMP/snapshot.json" "$TMP/clear-chain.json" <<'PY'
import json, sys
before = json.load(open(sys.argv[1]))
after = json.load(open(sys.argv[2]))
fixed = {slot["path"] for slot in before["chain"]["slots"]
         if slot["fixed"] and slot["path"]}
remaining = {block["path"] for block in after["chain"]["blocks"]}
assert remaining == fixed, (remaining, fixed)
assert len(remaining) < len(before["chain"]["blocks"]), "clear removed no blocks"
print("clear chain assertion passed")
PY

echo
echo "SMOKE PASSED"
