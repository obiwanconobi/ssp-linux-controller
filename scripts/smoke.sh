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

echo "== upload a small NAM =="
python3 - "$TMP/test.nam" <<'PY'
import json, sys
json.dump({"version": 0.5, "metadata": {"name": "Smoke Test", "gear_type": "amp"}},
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
print("NAM upload assertion passed")
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

echo
echo "SMOKE PASSED"
