# Remaining hardware validation

This checklist covers the device-writing tests that are still open after the
read-only pass, tuner validation, Save As, NAM A1 upload, and Clear Chain.
Run it against a **backed-up or scratch device state** and keep
[`DEVICE_SAFETY.md`](DEVICE_SAFETY.md) open while testing.

Record the build version from **Settings → About** and the firmware version from
the connection summary. A test is only complete when the observed pedal
behaviour and the app state agree.

## Already validated

Do not re-run these unless a related code path changes:

- Tuner open/close with X, T, and Esc, including a tuner that was already on.
- NAM A1 upload to a free amp slot.
- NAM A2, PNAM, and IR uploads to free slots, including the final marker/ACK.
- Clear Chain with fixed blocks and connectors preserved.
- Ten-minute idle polling, read-only.
- Save As to a new preset and duplicate-name rejection.
- Read-only snapshot mapping, all block editors, and UI mapping.

## Safety rules

- Stop at the first unexpected write, error, or device reboot. Do not retry
  blindly.
- Do not run a factory reset as part of this checklist. Factory reset and
  multi-item deletion remain deferred until a full backup/recovery path is
  available.
- Use free or scratch slots for uploads and overwrite tests.
- Do not disconnect USB while a preset save, upload, or chain edit is in flight
  unless the test explicitly calls for it.
- Keep a known-good preset, a known-good NAM/PNAM/IR file, and a recovery plan
  available before starting.
- If the pedal stops responding, stop writing, disconnect, and follow the
  recovery steps in [`DEVICE_SAFETY.md`](DEVICE_SAFETY.md).

## Test setup

1. Connect the pedal over USB and confirm the app is in **device** mode, not
   demo mode.
2. Confirm firmware and node count in the connection summary.
3. Select a scratch preset or a preset whose contents you can lose.
4. Open **Settings → Diagnostics** and confirm the app version and transport.
5. Keep the app's Activity drawer open for a timestamped record.
6. For upload tests, use known-good files from the project fixtures or your own
   validated files. Never use a synthetic or truncated model.
7. Prepare a folder for screenshots, logs, and copied diagnostics.

## V1 — Upload cancellation after an ACK

**Goal:** cancelling an upload stops further chunks without corrupting the target
list or leaving the app stuck.

1. Pick a free scratch capture slot.
2. Start a known-good NAM, PNAM, or IR upload.
3. Wait until the ACK counter has advanced past the first chunk (the UI shows
   `ACK n / total`).
4. Click **Cancel** once, while the upload is still running.
5. Watch the upload card until it reports cancelled or failed.
6. Refresh the library list.
7. Verify the target slot is empty or still contains its previous value.
8. Verify the rest of the chain and other capture lists are unchanged.
9. Try another upload to confirm the actor and poller recovered.

**Pass:** cancellation is acknowledged, no further progress appears, the target
slot is unchanged, and a subsequent upload still works.

**Record:** ACK number at cancel, resulting state, target slot, screenshot, and
whether any error toast appeared.

## V2 — Overwrite a used capture slot

**Goal:** the upload path replaces a used slot only after confirmation and leaves
a loadable capture.

1. Pick a used scratch slot and note its current name.
2. Start an upload to that exact slot.
3. Confirm the overwrite warning names the slot and the existing capture.
4. Complete the upload.
5. Refresh the list and confirm the new name and used state.
6. Load the preset or block that uses that capture and confirm it still loads.
7. Delete or replace the scratch capture only after the test.

**Pass:** the overwrite warning is accurate, the slot shows the new capture, and
the pedal can load it.

**Record:** old name, new name, slot number, warning text, and readback result.

## V3 — Single-item deletion

Run these one at a time. After each delete, refresh and verify the slot is empty
and later slots did **not** shift.

### V3a — Preset slot

1. Select a scratch preset that is not the active preset.
2. Delete it from the patch rail.
3. Confirm the dialog names the preset.
4. Refresh and verify the slot is empty.
5. Select another preset and confirm indices and names are stable.
6. Repeat once for the active preset, then load a different preset and confirm
   the board is still usable.

### V3b — NAM, PNAM, and IR captures

Repeat for each list:

- Amps → NAM
- Amps → Parametric NAM
- Drives → NAM
- Drives → Parametric NAM
- IRs

1. Delete a used scratch capture from the selected list.
2. Confirm the dialog names the capture.
3. Refresh and verify the slot is empty.
4. Verify the slot index did not move and the surrounding names are unchanged.
5. If the capture was active in the current preset, load a different preset and
   confirm the block reports the missing capture cleanly rather than crashing.

**Pass:** each target empties, indices remain stable, no unrelated slot changes,
and the app stays usable.

**Record:** list, slot, old name, readback, and any block-level warning.

## V4 — EQ writes

**Goal:** every EQ edit reaches the pedal and survives a refresh.

1. Open **Global EQ**.
2. Toggle EQ enabled/bypassed and confirm the pedal's EQ state changes.
3. Change one band's gain, frequency, Q, and type/slope.
4. Refresh the snapshot and confirm the values persist.
5. Reload the preset and confirm the EQ values are restored.
6. Undo the EQ changes and confirm the inverse values are written.
7. Repeat one edit with a second client or the pedal UI open, if available, to
   confirm the conflict path is not triggered by the app's own write.

**Pass:** every field round-trips, bypass is honoured, and no unrelated bands
change.

**Record:** band, field, before/after values, and refresh result.

## V5 — Chain move and link writes

**Goal:** router edits change the pedal's signal path in the expected order.

1. On the Board, move a movable block one slot left or right.
2. Refresh and confirm the block order matches the UI.
3. Move a block into an empty slot and back.
4. Change a link between **Series** and **Parallel** and confirm the connector
   and audio path change.
5. Reload the preset and confirm the order and links are preserved.
6. Undo the move/link and confirm the inverse write is accepted.

**Pass:** the pedal shows the same order and link type as the app after refresh
and after preset reload.

**Record:** before/after slot positions, link type, and refresh result.

## V6 — USB unplug/replug mid-poll

**Goal:** reconnect is clean and no queued write lands on the wrong connection.

1. Open the Board and let polling run for at least 10 seconds.
2. Unplug USB while the app is polling.
3. Confirm the app shows the offline/disconnected state and does not spin.
4. Replug USB.
5. Wait for reconnect and a fresh snapshot.
6. Make one harmless control edit after reconnect.
7. Confirm the write reaches the pedal and no stale write is replayed.

**Pass:** the app reconnects, shows a fresh revision, and only the post-reconnect
write is applied.

**Record:** time offline, reconnect time, any error toast, and the post-reconnect
snapshot revision.

## V7 — External changes with a pending local edit

**Goal:** a device-side change while a local write is pending produces a
resolvable conflict instead of silently overwriting either side.

1. With the app open, select a block with a control you can also change on the
   pedal.
2. Start a local edit but leave it pending long enough to overlap an external
   change. If necessary, use a slow network connection.
3. Change the same control on the pedal.
4. Confirm the conflict bar appears and names the control.
5. Choose **Use device** and confirm the app adopts the pedal value.
6. Repeat and choose **Keep local**; confirm the app writes the local value.
7. Confirm unrelated controls and the rest of the chain are unchanged.

**Pass:** the conflict is visible, both resolutions produce the expected value,
and no stale write reappears after refresh.

**Record:** control, local value, device value, chosen resolution, and
post-resolution readback.

## V8 — Device undo/redo

**Goal:** undo/redo replays the correct inverse operation and clears correctly on
reconnect.

Test each operation separately:

1. Change a control and press **Undo**; confirm the previous value is written.
2. Press **Redo**; confirm the new value is written.
3. Toggle a block bypass and undo/redo it.
4. Change master volume or tempo and undo/redo it.
5. Change an EQ band and undo/redo it.
6. Move or link a block and undo/redo it.
7. Create a conflict, then confirm undo is blocked until the conflict is
   resolved.
8. Disconnect and reconnect; confirm the undo and redo stacks are cleared.

**Pass:** each undo/redo writes the expected value, conflicts block history
replay, and reconnect clears history.

**Record:** operation, before/after values, and whether the history cleared after
reconnect.

## V9 — Upload audio verification

**Goal:** an uploaded capture is not only listed but produces the expected sound.

1. Upload a known-good NAM, PNAM, or IR to a scratch slot.
2. Load the capture in its block and select the matching preset.
3. Connect a known DI signal and record the pedal output through USB audio.
4. Repeat the recording with the previous known-good capture or bypass path.
5. Compare level, latency, and a null test where possible.
6. Confirm there is no silence, clipping, runaway gain, or obvious model
   mismatch.
7. Reboot the pedal and confirm the uploaded capture still loads and sounds the
   same.

**Pass:** the capture loads after a reboot and the audio comparison is within the
expected level/latency tolerance.

**Record:** capture name, slot, reference path, recorded files, and any null-test
result.

## V10 — Input gain and connection state (0.6.0)

1. Open **Settings → Audio & pedal**.
2. Note `In 1 connection` / `In 2 connection` and plug/unplug each input.
3. Refresh and confirm the read-only state follows the pedal.
4. Write In 1 gain to −6.0 dB, refresh, then reconnect and read it back.
5. Repeat for In 2 at +3.5 dB.
6. Confirm changing gain does **not** mark the preset edited; save another
   parameter and confirm the dirty flag is explained by that parameter.
7. Set both gains back to their original values.

**Pass:** both gains survive refresh/reconnect within 0.1 dB; connection state
matches the jacks; gain alone does not force a preset save.

## V11 — Preset Level (0.6.0)

1. Confirm the lower-bar stepper is enabled and shows one decimal.
2. Use the buttons to move by 0.5 dB and the arrow keys to move by 0.1 dB.
3. Set a scratch preset to +6.0 dB and save.
4. Reload another preset, then reload the scratch preset; confirm +6.0 dB.
5. Export the preset and inspect `root\app\output\pst\level` in the `.pst`.
6. Import the bundle into an empty slot and confirm the level round-trips.

**Pass:** the control reads/writes −20…+20 dB, saves with the preset, and
survives export/import.

## V12 — Library downloads (0.6.0)

Repeat for a NAM, PNAM, and IR entry:

1. Click Download on a used Library row and save to a scratch folder.
2. Confirm progress advances and the progress card can cancel between chunks.
3. Cancel once and verify no final file appears.
4. Download again to completion.
5. For NAM/PNAM, parse the file as JSON and confirm the model structure.
6. For IR, confirm the saved file is a 8248-byte float WAV: RIFF/WAVE, format
   3, mono, 48 kHz, 32-bit, 2048 samples. Device IR slots store raw `f32`
   samples; the app adds the header.
7. Compare a downloaded NAM with the official app's copy when available.

**Pass:** files are byte-plausible, compressed models are decompressed, and
cancellation leaves no partial destination file.

## V13 — Preset export and import (0.6.0)

1. Select a scratch preset with NAM/PNAM/IR dependencies.
2. Export it and inspect `bdinfo.json`, `preset/`, and `dependencies/`.
3. Compare the exported `.pst` with the official app's export of the same slot
   after removing archive filename metadata.
4. Import the bundle into an empty preset slot.
5. Confirm identical dependencies are reused and the preset list name appears.
6. Read back the imported `.pst` and compare it with the source.
7. Edit a preset, export, import into another empty slot, and confirm every
   value matches.
8. Try a no-dependency preset and a deliberately malformed archive; confirm the
   malformed archive is rejected before any write.
9. During a scratch import, cancel a dependency upload and verify the reported
   partial state and target slot.

**Pass:** export matches the official shape, import selects an empty slot by
default, identical dependencies are reused, and failures name partial writes.

## V14 — Capture rename and reference updates (0.6.0)

Use scratch presets only.

1. Rename an unused NAM capture; refresh and confirm the name/readback.
2. Repeat for PNAM and IR.
3. Create a scratch preset that uses a scratch NAM capture.
4. Try to rename that capture in Library; confirm it is blocked and the dialog
   names the affected preset.
5. Run the manual experiment: rename it through the official app or a scratch
   write, reload the preset, and record whether `root\app\amp\model` and
   `root\presets.used` changed.
6. Repeat for PNAM and IR.
7. Decide whether v0.6.0 keeps used-capture blocking or allows rename with an
   affected-preset warning.

**Pass:** unused captures rename safely; used-capture behavior is documented and
matches the implemented policy.

## V15 — Parametric EQ graph writes (0.6.0)

1. Add the in-chain Parametric EQ block to a scratch preset.
2. Drag each band, use arrow keys, and change type/frequency/gain/Q in the
   cards.
3. Refresh and confirm the graph and cards keep the written values.
4. Save, reload, and confirm the values persist.
5. Bypass the block and confirm the graph remains editable and bypass state is
   separate.
6. Export the preset and confirm `root\app\parametric_eq\eq_par` values are in
   the `.pst`.

**Pass:** every graph/card edit round-trips through the block's own controls and
does not touch the Global EQ or Graphic EQ paths.

## Evidence to capture

For every test, record:

- build version and firmware version;
- test ID and pass/fail;
- device mode and transport;
- slot/list/index used;
- exact values before and after;
- screenshots or a short screen recording;
- copied diagnostic report from **Settings → Diagnostics**;
- any error toast text or Activity log entry.

## Stop and recover if

- the pedal reboots or stops accepting writes;
- a list or preset changes without a corresponding app action;
- a delete shifts indices or removes a fixed block/connector;
- an upload ACK advances after cancellation;
- reconnect replays a write that was issued before the disconnect;
- the app reports a value that the pedal does not show after refresh.

Stop writing, disconnect, and follow the recovery procedure in
[`DEVICE_SAFETY.md`](DEVICE_SAFETY.md).

## Not in this checklist

These remain deliberately deferred:

- multi-item list deletion (P1.2);
- factory reset (P1.3);
- Android physical-device, mDNS, USB-OTG, and Play Store validation;
- Android physical-device UI/native-shell validation (the emulator harness is
  in [`ANDROID_UI_TESTING.md`](ANDROID_UI_TESTING.md));
- Windows/macOS clean-machine installer checks;
- signing, notarization, and updater validation.
