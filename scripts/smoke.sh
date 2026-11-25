#!/usr/bin/env bash
# Phase 0/1 smoke: deterministic simulator -> headless Rust core -> assertions.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-45681}"
PORT2="${PORT2:-45682}"
SIM="$ROOT/target/debug/stomp-sim"
CLI="$ROOT/target/debug/stomp"
TMP="$(mktemp -d)"
trap '[[ -n "${SIM_PID:-}" ]] && kill "$SIM_PID" 2>/dev/null || true; [[ -n "${SIM2_PID:-}" ]] && kill "$SIM2_PID" 2>/dev/null || true; rm -rf "$TMP"' EXIT

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
assert len(snapshot["lists"]) == 6, len(snapshot["lists"])
level = snapshot["master"]["preset_level"]
assert level["id"] == r"root\app\output\pst\level", level
assert level["min"] == -20 and level["max"] == 20 and level["step"] == 0.1, level
assert snapshot["input"]["gain1"]["min"] == -15, snapshot["input"]
assert snapshot["input"]["gain1"]["max"] == 15, snapshot["input"]
assert snapshot["input"]["connected1"] is True, snapshot["input"]
assert snapshot["input"]["connected2"] is False, snapshot["input"]
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

echo "== add and inspect the Parametric EQ block =="
"$CLI" add-block "$ADDR" 0 18 'root\app\parametric_eq' >"$TMP/peq-add.json" 2>"$TMP/peq-add.log"
"$CLI" editor "$ADDR" 'root\app\parametric_eq' >"$TMP/peq-editor.json" 2>"$TMP/peq-editor.log"
python3 - "$TMP/peq-add.json" "$TMP/peq-editor.json" <<'PY'
import json, sys
snapshot = json.load(open(sys.argv[1]))
assert any(block["path"] == r"root\app\parametric_eq" for block in snapshot["chain"]["blocks"]), snapshot["chain"]["blocks"]
editor = json.load(open(sys.argv[2]))
group = next(item for item in editor["items"] if item["name"] == "eq_par")
names = {control["name"] for control in group["parameters"]}
for index in range(4):
    for field in ("band", "freq", "q", "type"):
        assert f"{field}_{index}" in names, (field, index, sorted(names))
print("Parametric EQ editor assertion passed")
PY
"$CLI" remove-block "$ADDR" 0 18 >"$TMP/peq-remove.json" 2>"$TMP/peq-remove.log"

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

echo "== download NAM, IR, and preset payloads =="
"$CLI" download-list-item "$ADDR" 'root\nam_amp' 0 "$TMP/downloaded.nam" >"$TMP/download-nam.json" 2>"$TMP/download-nam.log"
python3 - "$TMP/download-nam.json" "$TMP/downloaded.nam" <<'PY'
import json, sys
result = json.load(open(sys.argv[1]))
assert result["name"] == "Match Brave Hi D 3", result
assert result["kind"] == "nam", result
assert result["bytes"] > 0, result
data = json.load(open(sys.argv[2]))
assert data["architecture"] == "WaveNet", data
print("NAM download assertion passed")
PY

"$CLI" download-list-item "$ADDR" 'root\ir_list' 0 "$TMP/downloaded.wav" >"$TMP/download-ir.json" 2>"$TMP/download-ir.log"
python3 - "$TMP/download-ir.json" "$TMP/downloaded.wav" <<'PY'
import json, struct, sys
result = json.load(open(sys.argv[1]))
assert result["kind"] == "ir", result
assert result["bytes"] == 8248, result
data = open(sys.argv[2], "rb").read()
assert data[:4] == b"RIFF" and data[8:12] == b"WAVE", data[:16]
fmt = struct.unpack("<HHIIHH", data[20:36])
assert fmt[0] == 3, fmt          # IEEE float
assert fmt[1] == 1, fmt          # mono
assert fmt[2] == 48000, fmt      # sample rate
assert fmt[5] == 32, fmt         # bits per sample
assert data[48:52] == b"data", data[48:56]
assert struct.unpack("<I", data[52:56])[0] == 8192
print("IR download assertion passed")
PY

"$CLI" download-list-item "$ADDR" 'root\presets' 3 "$TMP/downloaded.pst" >"$TMP/download-pst.json" 2>"$TMP/download-pst.log"
python3 - "$TMP/download-pst.json" "$TMP/downloaded.pst" <<'PY'
import json, sys
result = json.load(open(sys.argv[1]))
assert result["name"] == "Match Brave Chorus", result
assert result["kind"] == "pst", result
assert result["bytes"] == 32768, result
raw = open(sys.argv[2], "rb").read()
assert raw.startswith(b"root\\app\\router:"), raw[:32]
print("preset download assertion passed")
PY

echo "== export the current preset bundle =="
"$CLI" export-preset "$ADDR" 3 "$TMP/Brave Smoke.zip" >"$TMP/export.json" 2>"$TMP/export.log"
python3 - "$TMP/export.json" "$TMP/Brave Smoke.zip" <<'PY'
import json, sys, zipfile
result = json.load(open(sys.argv[1]))
assert result["preset_name"] == "Match Brave Chorus", result
assert sorted(result["dependencies"]) == [
    "Klone 3", "Match Brave Hi D 3", "TJ3 58BND310"
], result
with zipfile.ZipFile(sys.argv[2]) as archive:
    names = sorted(archive.namelist())
    assert names[0] == "bdinfo.json", names
    assert "preset/Match Brave Chorus.pst" in names, names
    assert "dependencies/root/nam_amp/Match Brave Hi D 3.nam" in names, names
    assert "dependencies/root/nam_drive/Klone 3.nam" in names, names
    assert "dependencies/root/ir_list/TJ3 58BND310.wav" in names, names
    manifest = json.loads(archive.read("bdinfo.json"))
    assert manifest["preset"]["name"] == "Match Brave Chorus", manifest
    assert len(archive.read("preset/Match Brave Chorus.pst")) == 32768
    assert archive.read("preset/Match Brave Chorus.pst").startswith(b"root\\app\\router:")
print("preset export assertion passed")
PY

echo "== import the exported bundle back into its source slot =="
"$CLI" import-preset "$ADDR" "$TMP/Brave Smoke.zip" 3 --overwrite >"$TMP/import.json" 2>"$TMP/import.log"
python3 - "$TMP/import.json" "$TMP/Brave Smoke.zip" <<'PY'
import json, sys, zipfile
report = json.load(open(sys.argv[1]))
assert report["preset_name"] == "Match Brave Chorus", report
assert report["target_slot"] == 3, report
assert report["preset_bytes"] == 32768, report
assert sorted(report["dependencies_reused"]) == [
    "Klone 3", "Match Brave Hi D 3", "TJ3 58BND310"
], report
assert report["dependencies_written"] == [], report
with zipfile.ZipFile(sys.argv[2]) as archive:
    expected = archive.read("preset/Match Brave Chorus.pst")
    assert len(expected) == 32768
print("preset import assertion passed")
PY
"$CLI" download-list-item "$ADDR" 'root\presets' 3 "$TMP/imported.pst" >"$TMP/imported-preset.json" 2>"$TMP/imported-preset.log"
python3 - "$TMP/imported-preset.json" "$TMP/imported.pst" "$TMP/Brave Smoke.zip" <<'PY'
import json, sys, zipfile
result = json.load(open(sys.argv[1]))
assert result["name"] == "Match Brave Chorus", result
with zipfile.ZipFile(sys.argv[3]) as archive:
    expected = archive.read("preset/Match Brave Chorus.pst")
assert open(sys.argv[2], "rb").read() == expected
print("imported preset read-back assertion passed")
PY

if [ -f "$ROOT/docs/Brave.zip" ]; then
  echo "== import the official Brave reference bundle =="
  "$CLI" import-preset "$ADDR" "$ROOT/docs/Brave.zip" 51 >"$TMP/brave-import.json" 2>"$TMP/brave-import.log"
  python3 - "$TMP/brave-import.json" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
assert report["preset_name"] == "Brave", report
assert report["target_slot"] == 51, report
assert len(report["dependencies_written"]) == 4, report
assert report["dependencies_reused"] == [], report
print("Brave.zip import assertion passed")
PY
  "$CLI" download-list-item "$ADDR" 'root\presets' 51 "$TMP/brave-imported.pst" >"$TMP/brave-readback.json" 2>"$TMP/brave-readback.log"
  python3 - "$TMP/brave-imported.pst" "$ROOT/docs/Brave.zip" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[2]) as archive:
    expected = archive.read("preset/Brave.pst")
assert open(sys.argv[1], "rb").read() == expected
print("Brave.zip read-back assertion passed")
PY
else
  echo "== skip official Brave.zip import (local reference archive not present) =="
fi

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

echo "== delete a NAM list item =="
"$CLI" delete-list-item "$ADDR" 'root\nam_amp' 0 >"$TMP/delete-item.json" 2>"$TMP/delete-item.log"
python3 - "$TMP/delete-item.json" <<'PY'
import json, sys
snapshot = json.load(open(sys.argv[1]))
amp = next(item for item in snapshot["lists"] if item["path"] == r"root\nam_amp")
assert amp["slots"][0]["name"] == "", amp["slots"][0]
assert amp["slots"][0]["used"] is False, amp["slots"][0]
assert amp["slots"][1]["name"] == "64 Vibroverb D 2", amp["slots"][1]
print("delete list item assertion passed")
PY

echo
echo "SMOKE PASSED"
