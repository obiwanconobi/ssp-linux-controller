# Device safety — uploads, writes, and recovery

Last updated: 2026-11-22

Read this before adding any device write or running a hardware upload test. It
records a real soft-brick and the rules that came out of it.

## Incident summary

On 2026-11-22 a 177-byte synthetic `.nam` file was uploaded to
`root\nam_amp` slot 21 (wire index; UI slot 22) on firmware 2.5.3:

```json
{"version":"0.5.4","architecture":"WaveNet","config":{"layers":[]},"weights":[],"metadata":{"name":"StompStation Upload Test","gear_type":"amp"}}
```

The device ACKed all three chunks and reported success, but the application
then failed to start and the pedal stayed in **Update Mode**. A second official
2.5.3 flash reported success and did not fix it.

Key findings:

- Firmware updates replace `/home/app_run`; they do **not** erase NAM, PNAM,
  IR, or preset data. A bad capture survives a reflash.
- Update mode exposes only 21 system nodes. It has no capture lists, no
  settings tree, and no user-data/factory-reset action. The only writable paths
  are the firmware-update nodes.
- The malformed capture was the only persistent change made before the failure,
  and the app's model loader is not expected to survive an empty model.
- The device was recovered with a company-provided firmware and a device reset.

Never repeat this test. Synthetic or structurally empty models are simulator
fixtures only, never hardware uploads.

## Non-negotiable rules

1. **Uploads may target only these five capture lists:**
   - `root\nam_amp`
   - `root\nam_drive`
   - `root\pnam_list`
   - `root\pnam_drive`
   - `root\ir_list`

   Never write to `root\presets`, `root\settings`, `root\sys\_upd`,
   `/home/app_run`, or any arbitrary node with capture-like data.

2. **Never send `supd` or `upd` outside the official firmware updater.** Those
   write the application image and reboot the pedal.

3. **Never upload a synthetic, stub, truncated, or hand-written model to
   hardware.** Use it only with the local simulator. The first hardware upload
   of a new format must use a known-good file in a scratch/free slot.

4. **Run the local simulator first.** `scripts/smoke.sh` covers NAM, PNAM, IR,
   stub rejection, and wrong-kind target rejection. Add a simulator case for
   every new file format or list-type variant.

5. **Record the slot correctly.** The wire/API slot index is 0-based; the UI
   displays it 1-based. The incident wrote wire slot 21 (UI slot 22).

6. **Do not power-cycle during an upload or firmware write.** Uploads pause
   polling and own the transport; wait for the final ACK or cancel boundary.

7. **Validation is structural, not semantic.** The validator proves that a
   file has the expected model/WAV shape; it cannot prove the pedal's loader
   will accept a particular architecture or weight set.

8. **When a legitimate file is rejected, do not remove validation to make it
   pass.** Capture the file's structure, add a regression test, and extend the
   validator for that exact shape.

9. **Destructive chain actions need confirmation.** Clear Chain must remain
   behind a confirmation dialog; it removes every movable block while keeping
   fixed blocks and links.

## Format facts learned from real firmware

### NAM A1 (WaveNet / LSTM)

A1 files (the long-standing NAM format) use an `architecture` such as
`WaveNet` or `LSTM`, an architecture-specific `config` object (for WaveNet:
`layers`, `head`, `head_scale`), and a **non-empty top-level `weights` array**
of numbers.

Validation must keep accepting this shape. Do **not** require A2/PNAM keys
(`submodels`, `models`, `max_value`) for A1, and do not require the config to
have any particular keys beyond being an object.

A real A1 `WaveNet` file with 13,802 flat weights was checked through preflight
and a 131-chunk simulator upload. A1 has a dedicated regression test
(`preflight_accepts_a1_wavenet_with_flat_weights`) and a smoke case; both A1
and A2 must stay green.

### NAM v0.7 A2 / SlimmableContainer

A2 files legitimately have an **empty top-level `weights` array**. The network
weights live in `config.submodels`, with each entry wrapping a child model:

```json
{
  "version": "0.7.0",
  "architecture": "SlimmableContainer",
  "config": {
    "submodels": [
      {
        "max_value": 0.5,
        "model": {
          "architecture": "WaveNet",
          "config": {},
          "weights": [0.1, 0.2],
          "sample_rate": 48000
        }
      }
    ]
  },
  "weights": []
}
```

The validator must recurse through `config.models` (Sequential),
`config.submodels` (A2/PNAM containers), `{ "model": ... }` wrappers, and
object-map container forms. A flat-weights-only check rejects legitimate A2
files.

### IR capture lists

- The list item type is firmware-dependent. Observed values include `ir`,
  `wav`, and `wav_48000`.
- Accept exact types and rate-tagged variants (`wav_*`, `ir_*`) on known
  capture paths. Known paths may also be untyped on older firmware.
- The **source WAV may be much larger than the slot**. The slot stores 2048
  decoded `f32` samples (8192 bytes); do not compare the raw WAV byte count to
  the slot size. Decode first, then upload the fixed 8192-byte payload.
- WAVs are reduced to the first 2048 frames; short files are zero-padded.

### Capture-list metadata

Firmware may use exact types (`nam`, `pnam`, `ir`, `wav`), rate-tagged types
(`wav_48000`, `nam_48000`), or no type at all on a known path. Keep the known
path allowlist and reject wrong-kind or unknown lists. Add new observed type
variants with a regression test.

## Code map

| Concern | Location |
| --- | --- |
| Model structure validation, preflight, chunking, gzip/marker | `crates/stomp-upload/src/lib.rs` |
| Target-list guard, ACK loop, progress, cancel boundary | `crates/stomp-device/src/device.rs` |
| Poll pause, Tauri events, concurrent-upload guard | `apps/desktop/src-tauri/src/commands.rs` |
| File picker, preflight panel, queue, highlight | `apps/desktop/ui/src/features/library/LibraryView.tsx` |
| Upload state, progress, cancel, snapshot refresh | `apps/desktop/ui/src/stores/useAppStore.ts` |
| Simulator regression cases | `scripts/smoke.sh` |

The upload wire format is:

```text
dwrite <listPath>:{"index":<slot>,"chunk":0,"value":"<128-byte name as hex>"}
dwrite <listPath>:{"index":<slot>,"chunk":1..N,"value":"<1024-byte chunk as hex>"}
```

- Model uploads use the 2048-character final `gz` marker or a marker-only
  chunk.
- IR uploads send eight fixed data chunks; the final full chunk must ACK
  `chunk:-1`.
- Cancel is checked at ACK boundaries; the final ACK still completes the
  upload.

## Recovery playbook if the app will not boot

1. **Stop writing.** Do not send guessed `dwrite`, `write`, `supd`, or `upd`
   commands.
2. Confirm whether the pedal is in update mode:
   - `root\sys\_ver` reports `Update Mode`.
   - Only 21 system nodes are present (`root`, `root\app`, `root\sys\*`,
     Wi-Fi, USB).
   - Reads to `root\nam_amp`, `root\pnam_list`, `root\ir_list`,
     `root\presets`, and `root\settings` time out.
3. Remember that reflashing the app image does **not** clear captures. If a bad
   capture is crashing the app, another flash will not fix it.
4. Options, in order of preference:
   - Check the official updater for a user-data reset/factory-reset option.
   - Ask Sonulab support for a recovery image or reset procedure; provide the
     exact slot/path, capture name, firmware version, and error text.
   - If available and acceptable, boot an older official firmware that can run,
     clear the bad slot through the normal protocol, then reinstall the target
     firmware. This is a calculated risk.
   - Physical eMMC/SD/UART or Raspberry Pi USB-boot recovery is the last resort.
     Do not open the pedal without a backup plan.
5. Do not factory reset without a backup unless losing all presets and captures
   is acceptable.

## Hardware test checklist

Before the first hardware upload after a code change:

- [ ] `cargo test --workspace` passes.
- [ ] `cargo clippy ... -D warnings` passes.
- [ ] `scripts/smoke.sh` passes, including a representative file for the
      format being changed.
- [ ] UI tests / `ui-smoke` pass if the picker or store changed.
- [ ] The test file is known-good, not synthetic.
- [ ] If the upload format changed, both a flat-weight A1 NAM and an
      A2/PNAM container shape are covered.
- [ ] The target is a free/scratch slot in one of the five capture lists.
- [ ] The wire slot vs UI slot is recorded.
- [ ] A backup or known-good recovery path exists.
- [ ] Polling is paused during the upload and the list is read back after the
      final ACK.

If any of these are false, use the simulator only.
