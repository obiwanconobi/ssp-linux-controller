# Hardware validation — 2026-11-20

> **Before any device write or upload test, read
> [`DEVICE_SAFETY.md`](DEVICE_SAFETY.md).** It records the 2026-11-22
> soft-brick, the format/list invariants, and the update-mode recovery
> playbook.

## Device

| Field | Value |
| --- | --- |
| Model | StompStation PRO |
| Firmware | 2.4.4 |
| Device ID | `a13c18be0000001088a29e9e5d7d` |
| Transport | USB CDC-ACM `/dev/ttyACM0`; mDNS Wi-Fi `192.168.1.97:8080` |
| Browse size | 688 nodes |
| Chain | 12 blocks, 14 router slots (2 empty) |
| Presets | 60 names |
| Captures | NAM amp 60, PNAM amp 10, NAM drive 60, PNAM drive 10, IR 50 |

The full snapshot and every block editor were captured to
[`fixtures/snapshots/hardware-2.4.4.json`](../fixtures/snapshots/hardware-2.4.4.json)
with:

```bash
cargo run -p stomp-cli --bin stomp -- fixture serial:/dev/ttyACM0 \
  fixtures/snapshots/hardware-2.4.4.json
```

## Read-only differential

The Python client (`Legacy/stomp.py`) and the Rust core were
run against the same pedal without writing. They agreed on:

- device name, firmware, and ID;
- current preset `Dumble Carlton`, all 60 preset names, and the preset list ref;
- all 12 chain block labels, paths, families, and on/off states;
- master volume `87.0` (0–100) and tempo `80.0` (30–240);
- all five capture lists and their slot counts;
- global EQ path `root\app\output\global_eq`, four bands, beat values, Q, and
  band type `BP`.

Python reports the extra `root\presets` list in its state bag; Rust keeps the
preset namespace in `PresetView` instead, which is intentional.

## Firmware 2.5.3 read-only pass (2026-11-21)

The same pedal was updated to 2.5.3 and checked over Wi-Fi:

- `root\sys\_ver` reports `2.5.3`; `browse root` returns 694 nodes;
- preset, capture-list, master, and global-EQ shapes are unchanged;
- the active PNAM amp (`[AMP] RVRA.KR7-Mar-CH3`) is a
  `ParametricSlimmableContainer`; its `p1` is a `switch` styled
  `vtype:["ON","OFF"]` with `value: 0.5` (position 1, `OFF`);
- two simultaneous TCP clients both received the full browse response and
  continued to receive `read root` deltas;
- the USB descriptor now reports product `StompStation`, serial
  `STOMPPRO-…-ACM`, and `bcdDevice 0x0104`.

The new switch shape is parsed by both clients; see
[`FIRMWARE_2.5.3.md`](FIRMWARE_2.5.3.md) for the full
firmware diff and remaining notes. No 2.5.3 snapshot fixture was committed
because it contains the user's capture/preset names.

## UI-level verification with the real fixture

The browser build was loaded with a mocked `window.__TAURI_INTERNALS__.invoke`
that returned the hardware fixture for `connect`, `get_snapshot`, and
`select_block`. Clicking the actual connection sheet then ran the real store
mapping path:

- preset rail: `Dumble Carlton`, 36 named patches across 60 device slots;
- board: 12 pedals, 3 fixed, correct on/off states;
- master: volume 87, tempo 80, preset level `—`;
- amp room: real NAM model names, lane 2 off, pan values, IR name;
- global EQ: bypassed, four bands normalized to 1–4;
- library: five capture lists and real slot counts;
- no console or page errors.

Screenshots are in [`docs/screenshots/`](screenshots/). This verifies the same
mapping code the Tauri commands feed. The Tauri IPC layer was later exercised by
launching the installed release, which auto-connected over Wi-Fi and loaded the
live snapshot. Write commands use the same `Device` core and were exercised
through the CLI; the app’s Save/Remove/Replace buttons are thin wrappers over
those commands.

## v0.4.0 read-only pass (2026-11-22)

The v0.4.0 release was checked over USB on firmware 2.5.3 (694 nodes) without
issuing any write commands:

- snapshot: 7 chain blocks, 3 fixed (amp, delay, reverb), 14 router slots
  (7 empty), 19 available blocks;
- preset list: 60 slots, 20 named; capture lists: 60/10/60/10/50 slots with
  17/1/2/5/8 used;
- capabilities: router, global EQ, tuner, dual NAM, dual IR, parametric NAM;
- all 7 block editors read and mapped; dual NAM/IR groups present; global EQ
  disabled with four flat bands; master 62%, tempo 184 BPM; preset level not
  exposed by this firmware;
- browser UI loaded that snapshot through a mocked Tauri IPC bridge: 7 pedals,
  3 fixed, correct preset and chain order, two amp lanes, four EQ bands,
  library tables, and **zero write commands**;
- ten-minute idle `read root` polling: **PASS** — 1,179 successful reads, 0
  errors, meters updated continuously, preset and 7-block chain unchanged; the
  post-run snapshot matched the pre-run snapshot;
- read-only tuner probe: the `on_off` node exists and reported `OFF`. The live
  values are under `root\settings\tuner\tuner\_freq`, `...\lvl`, and
  `...\ref`; the guessed `...\note`, `...\cents`, `...\freq`, and
  `...\level` paths used by 0.4.1 do not exist and timed out, which also
  backlogged tuner polls ahead of the close write. v0.4.2 corrects the paths and
  computes note/cents; full open/close still requires the write-based test.

No user capture/preset names were committed. One UI-label nit was observed:
the in-chain EQ block uses the generic `UTILITY` shell plate because there is
no distinct EQ block family; state mapping and editing are unaffected.

## Reversible write test — gate only

This was the first, minimum-risk hardware write test. With explicit user
approval, only the Noise Gate was written:

1. fresh snapshot: gate `OFF`;
2. write `root\app\gate\on_off = {"value":"ON"}`;
3. read back: gate `ON`;
4. write `root\app\gate\on_off = {"value":"OFF"}`;
5. read back: gate `OFF`;
6. fresh final snapshot: gate `OFF`, preset still `Dumble Carlton`.

No preset save, model/IR changes, router edits, EQ writes, or uploads were
performed in this gate-only test. A shell trap re-asserted OFF if any step
failed. Later save/chain tests are documented below.

## Firmware differences found, and fixes

| Difference | Fix |
| --- | --- |
| EQ bands are 0–3 on hardware (simulator used 1–4). | `EqBandView.index` is always 1–4 for the UI; `device_index` preserves 0–3 for writes. |
| Global EQ controls live inside an `eq_par` group and firmware types include `LPS/LP/BP/HP/HPS`. | UI response math now supports low/high pass; type mapping covers all five firmware values. |
| Global bypass is separate from band values (`on_off` is OFF; bands all report enabled). | Added store-level `eqEnabled`, mapped from the snapshot. |
| Delay Time and Mod Rate are tempo modules; the useful value is `rawdata`, not a direct parameter. | Group conversion synthesizes a shell-eligible time/rate control from `rawdata`; the module mode selector is exposed. |
| Compressor uses `sensitivity` / `makeup`, not `thresh` / `ratio` / `lvl`. | Aliases and shell priorities updated; labels prefer the firmware description. |
| Cabinet uses `lo_cut` / `hi_cut`; reverb pre-delay is `pre_dly`; mod depth is `dpth`. | Alias table updated for shell knob selection. |
| No preset-level node on 2.4.4. | `presetLevelAvailable` is false; the master strip shows `—` and disables the stepper. |
| Tempo range is 30–240, not 20–300. | Master ranges are carried from the device snapshot; tempo steppers clamp accordingly. |

Updated regression tests:

- [`src/ipc/mapSnapshot.test.ts`](../apps/desktop/ui/src/ipc/mapSnapshot.test.ts)
  maps both the simulator and hardware fixtures, including 0-based EQ
  normalization and the real 60-preset/5-list surface.
- [`src/components/kit/knobMap.test.ts`](../apps/desktop/ui/src/components/kit/knobMap.test.ts)
  asserts real hardware knob choices for drive, amp, compressor, delay, mod,
  and cab.

## Chain edit payload fix (simulator + partial hardware)

A UI report that “Remove from chain” did nothing traced to `Device::edit_chain`:
it sent the router matrix as the top-level write payload
(`write root\app\router:[[...]]`). The firmware write shape is an object, so
the ACK never arrived and the command timed out. The router write is now wrapped
as `write root\app\router:{"value":[[...]]}` for add, remove, move, replace,
and link.

The simulator smoke performs remove → add → replace → replace-back and asserts
the resulting labels, empty slots, and available-block list. Add/remove were
then exercised on hardware during the reversible save test below, including a
fresh-read check. Move/link still need a hardware pass; they use the same
wrapped router payload.

## Preset save field-order fix (hardware-validated)

The “Save does not persist chain/parameter edits” report was reproduced on the
pedal. Rust’s `serde_json` default sorted object keys, so the save command went
out as `{"save":"save","value":"Dumble Carlton"}`. The firmware applies fields
in order: it persisted the old state, then treated `value` as a preset load and
restored the stored preset.

The client now enables `serde_json`’s `preserve_order`, matching the device
app’s wire shape `{"value":"...","save":"save"}`. Coalesced knob/model writes
are flushed before the save command, and router edits now keep the preset
marked dirty instead of being cleared by a refresh.

Reversible hardware test, 2026-11-20:

1. baseline: preset `Dumble Carlton`, Noise Gate in slot `(0,0)`, Drive gain
   `2.20765`;
2. removed the Noise Gate and set Drive gain to `2.5`;
3. saved;
4. fresh connection/read: Noise Gate still removed, Drive gain `2.5`;
5. restored the Noise Gate at `(0,0)` and Drive gain to `2.20765`, saved;
6. fresh connection/read: original chain and gain restored, preset unchanged.

Command-level regression tests assert the exact save and `dwrite` field order.
After the restore, a full fresh snapshot matched the pre-test snapshot exactly
(ignoring revision, meters, and USB status): preset `Dumble Carlton`, original
12-block chain, Noise Gate `OFF`, Drive gain `2.20765`.

## Parametric NAM editor mapping

The live drive editor was captured read-only while the block was in Parametric
NAM mode. It exposed both loaders (`model` hidden, `pmodel` visible) plus the
model-dependent `p1..p3` pfloat controls and the legacy NAM tone controls
hidden. The desktop mapper previously always selected `model`, so the normal
NAM list stayed on screen and the shell text followed the inactive model.

The mapper now prefers the visible loader and treats `pmodel` as a model
control. Selecting a PNAM model rebrowses that block so the model-dependent
labels/ranges load; switching type with an empty PNAM slot selects the first
available model, matching the Python client. Regression coverage includes the
real 2.4.4 PNAM editor shape and the type-change/default-model flow.

The corrected PNAM loader, pedal-shell model, and model-dependent controls were
confirmed on the live pedal by the user. The fix itself required no hardware
write; it was validated from the captured PNAM editor shape plus the UI smoke.

## Startup discovery

The Tauri app now starts disconnected. It browses mDNS `_http._tcp` for a
service whose TXT `id` contains `voidx`, tries those first, then probes USB
serial ports, and finally opens the connection sheet with the discovery error.
The browser preview is unaffected; the Tauri demo is opt-in with `--demo` or
`STOMPSTATION_DEMO=1`. UI startup smoke covers no-device, demo, and USB-success
states with mocked IPC.

The installed release was launched against the real pedal on 2026-11-20. It
found the `_http._tcp` service and auto-connected over Wi-Fi at
`192.168.1.97:8080`, then loaded the 12-block board read-only. The app was
closed after verification; no chain write was issued.

## Regression coverage

The hardware-free suite is the release gate:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace          # 96 tests
./scripts/smoke.sh              # simulator, chain edits, save path, preset, upload

cd apps/desktop/ui
pnpm lint
pnpm test                       # 72 Vitest tests
pnpm build
pnpm test:ui
pnpm test:mobile
pnpm test:startup
pnpm test:a11y
pnpm test:keyboard
pnpm test:states
pnpm test:visual
pnpm test:perf
```

Relevant focused tests:

- [`src/ipc/mapSnapshot.test.ts`](../apps/desktop/ui/src/ipc/mapSnapshot.test.ts):
  active NAM/PNAM loader selection and PNAM controls.
- [`src/stores/useAppStore.test.ts`](../apps/desktop/ui/src/stores/useAppStore.test.ts):
  dirty-state persistence, save clearing, chain remove routing, and the
  type-change/default-PNAM-model flow.
- [`crates/stomp-protocol/src/command.rs`](../crates/stomp-protocol/src/command.rs):
  exact `value`-before-`save` and `index`/`chunk`/`value` ordering.
- [`scripts/smoke.sh`](../scripts/smoke.sh): simulator remove/add/replace and
  preset/upload assertions.

## Android validation (emulator)

The Tauri Android app was built for `aarch64` and `x86_64` and run on a Pixel 10
Pro API 37 x86_64 emulator. The release APK connected over TCP to the bundled
simulator through `adb reverse tcp:45700 tcp:45700` and loaded the full board,
inspector, chain, and master controls. The mobile connection sheet correctly
omitted USB and used Wi-Fi/manual TCP.

The build targets SDK 36 because SDK 37 enforces `ACCESS_LOCAL_NETWORK` as a
runtime permission; target 36 keeps `INTERNET`’s implicit LAN access for this
sideload APK. Bumping to 37 requires adding and requesting that permission.

Android constraints:

- no USB serial/OTG path; the transport stub returns “unsupported”;
- mDNS requires the `MulticastLock` in `MainActivity`; emulator mDNS is not a
  reliable test because its virtual network does not route to the host LAN;
- the physical phone has not been tested;
- release APKs are signed with the local Android debug key for sideloading.

See [`ANDROID.md`](ANDROID.md) for build and install instructions and
[`ANDROID_UI_TESTING.md`](ANDROID_UI_TESTING.md) for the emulator UI/native-shell
harness and its remaining physical-device work.

## Upload flow (wired 2026-11-22)

The Library now drives the real uploader instead of a preview:

- the Tauri file picker and native drag-drop pass real filesystem paths;
- `preflight_upload` reads the device slot list, validates the file, and
  returns the chosen slot plus overwrite warnings;
- model validation requires valid JSON, an architecture, a config object, and
  numeric weights; it accepts flat WaveNet/LSTM weights, Sequential
  `config.models`, and v0.7 `SlimmableContainer`/`ParametricSlimmableContainer`
  `config.submodels` (A2/PNAM), including `{ "model": ... }` wrappers. IR WAVs
  are decoded before upload, and source WAVs may be larger than the 8 KiB
  decoded slot; the target must be a `nam`, `pnam`, or `ir` capture list.
  Firmware may label list types as `ir`, `wav`, or rate-tagged forms such as
  `wav_48000`; known capture paths also accept an untyped list;
- `begin_upload` pauses the poller, streams `device://upload` ACK events,
  checks the cancel flag at each ACK boundary, then returns a fresh snapshot;
- the UI applies that snapshot, refreshes the list, and highlights the new
  slot. Browser/demo mode still simulates progress.

### Validated on 2.5.3 (2026-11-22)

- a known-good NAM v0.7 A2 `SlimmableContainer` upload to a free amp slot,
  including the final 2048-character marker;
- a NAM A1 WaveNet file with 13,802 flat weights uploaded to a free amp slot
  (user-confirmed on 2.5.3);
- a Parametric NAM container upload to a free PNAM slot;
- a 24-bit/48 kHz mono IR WAV to a free IR slot, with the IR list reporting
  `item_type: wav_48000`;
- a synthetic stub NAM rejected before any bytes were sent, and a wrong-kind
  target rejected before any write.

Still open: cancel-after-ACK on hardware, overwriting a used slot, and audio
readback/verification.

> Preflight is structural, not semantic: it cannot prove a model is loadable
> by this firmware. Use files exported by a compatible NAM/PNAM version, and
> keep a known-good file for the first hardware pass.

## List deletion

Preset and capture lists now expose per-row delete actions. The implementation
uses the official VoidX-Control behavior documented in
[`voidx-delete-button-behavior.md`](voidx-delete-button-behavior.md):

```text
dwrite <listPath>:{"index":N,"chunk":-1,"value":"<128 zero bytes as hex>"}
```

The backend permits only preset and capture lists, rejects empty/out-of-range
slots, sends one command per item, reads the list back, and verifies the name
was cleared. Indices are not shifted. The simulator and UI tests cover the
flow; the firmware's exact zero-fill/ACK semantics are still unvalidated on
hardware.

## Tuner open/close (validated 0.4.2 / 2.5.3)

Opening the deck turns the pedal tuner on, and closing it with X, T, or Esc
turns it off, including when the tuner was already on before opening. v0.4.2
also reads the live tuner module paths and serializes polls; the actor simulator
test covers live readback, repeated open, and close-to-OFF. The earlier 0.4.1
close write was correct, but tuner polls against guessed paths timed out and
queued ahead of the OFF write.

## Save As (validated on 2.5.3)

Save As creates a new preset slot on this firmware. Existing names are rejected
since 0.4.1 by the dialog, the store, and the device core; the firmware does not
overwrite an existing preset, and the UI no longer claims it will.

## Remaining validation procedure

Use [`REMAINING_VALIDATION.md`](REMAINING_VALIDATION.md) for the step-by-step
write tests, expected results, evidence to capture, and stop conditions.

## Still unvalidated on hardware

These intentionally remain on the Phase 3 checklist:

- A1 NAM upload on real hardware. A1 is covered by the validator and simulator,
  but only A2/PNAM/IR uploads have been recorded on 2.5.3 so far;
- list deletion on hardware (presets, NAM, PNAM, IR). Verify the slot empties,
  indices do not shift, the ACK is completion, and deleting an active/current
  item does not leave the app or a block in a broken state;
- upload cancellation after an ACK, overwriting a used slot, and audio
  readback/verification. Basic NAM A2/PNAM/IR uploads were validated on 2.5.3
  (see the upload section above), including the A2 final marker;
- live snapshot polling for 10 minutes and reconnect after unplugging USB
  mid-poll (10-minute idle polling passed read-only on 2026-11-22; the
  single-owner actor has capped reconnect backoff and rejects stale queued
  writes; hardware reconnect still needs a pass);
- external preset/chain/control changes from the pedal while the app is open,
  including a local edit pending at the same time (the conflict bar and
  stale-write rollback are simulator/unit tested);
- EQ writes and chain move/link writes on hardware. Chain add/remove, Clear
  Chain, and the PNAM editor have been exercised; move/link and EQ writes still
  need a pass. Clear Chain preserves fixed blocks/connectors and is
  user-confirmed on 2.5.3.
- device undo/redo of control, master, EQ, bypass, and router edits, including
  history clearing after reconnect (simulator/store tests cover the inverse
  writes; hardware pass pending).
- Android on a physical phone, including Wi-Fi mDNS discovery, one-client
  behavior, and reconnect after screen lock;
- factory reset (do not run without a fresh backup).
