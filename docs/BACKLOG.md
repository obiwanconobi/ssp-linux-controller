# Backlog

See [`V0.6.0_PLAN.md`](V0.6.0_PLAN.md) for the next release scope: input
settings, Preset Level, Add-block scrolling, the Parametric EQ graph, preset
export/import, Library file downloads, and Library file renaming.

Last updated: 2026-11-23

## UI feedback — this pass

| # | Item | Status |
| --- | --- | --- |
| 1 | Signal-chain pedal text is obscured. | Fixed: wider/taller shells, reserved two-line model space, compact shell values, labels constrained to their knob column, mini shells capped at two knobs. |
| 2 | UI is slightly cluttered; some text is hard to read; styling is too muted. | Fixed in this pass: larger micro-type, stronger muted/text contrast, more spacing, removed a redundant inspector hint. Further density polish stays on the list below. |
| 3 | Hovering a knob shows the scroll/resize cursor. | Fixed: knob cursor is now `pointer`; dragging still works. |
| 4 | Signal-chain blocks should be centered. | Fixed: chain content is centered when it fits and scrolls from the start when it overflows. |
| 5 | NAM → Parametric NAM changes nothing. | Fixed: demo swaps to PNAM controls and model list; device mode refreshes the editor after the type write. |
| 6 | Drag to reorder does not work. | Fixed: drag anywhere on a movable pedal (knobs, value fields, and footswitches opt out); fixed slots still refuse. |
| 7 | Library needs a recursive local-folder scan. | Added: Local files tab, Tauri recursive scanner, browser directory picker, and one-click preflight. |
| 8 | Dials are not smooth; values cannot be typed. | Fixed: local drag values at pointer rate with throttled writes; click the value text to type with range validation. |
| 9 | Pedal bodies need full colour, not just accent strips. | Fixed: family chassis colours now fill each shell, with theme-aware ink tokens. |
| 10 | Fixed-slot badge obscures the ON state. | Fixed: the badge is now a lock-only icon at the bottom-left with the foot state shifted clear. |
| 11 | Bypass can appear to flip twice after one click. | Fixed: pending block writes and a revision guard prevent a stale poll snapshot from rewinding the local toggle. |
| 12 | Demo board is the default startup state. | Fixed: Tauri starts disconnected and scans mDNS Wi-Fi first, then USB. Demo is opt-in with `--demo`/`STOMPSTATION_DEMO=1`; the browser preview remains the deterministic demo. |
| 13 | Remove from chain does not work on the device. | Fixed: chain edits wrote the raw router matrix instead of `{"value": [...]}`. The payload is now wrapped, and add/remove/replace are covered by the simulator smoke. |
| 14 | Add a Replace with action beside Remove from chain. | Added: a dropdown submenu swaps the selected block in one router write; fixed slots and empty replacement lists are disabled. |
| 15 | Amp-room lanes read as large rectangles, not amps. | Restyled as tolex combo amps: strap handle, cream faceplate, knobs, jewel light, oxblood 2×12 grille, metal logo, and rubber feet. |
| 16 | Saving resets the chain and loses changed parameters. | Fixed: `serde_json` was sorting object keys, so Rust sent `{"save":"save","value":"..."}`. The firmware applies fields in order, saved the old state, then loaded the stored preset. `preserve_order` now matches the device app’s `{"value":"...","save":"save"}` shape; coalesced knob writes are flushed before save. Chain edits now mark the preset dirty, and a refresh no longer clears that flag. |
| 17 | Parametric NAM drive shows the normal NAM loader and no model parameters. | Fixed: the block mapper now chooses the visible model loader (`pmodel` for Parametric NAM, `model` for NAM) instead of always taking `model`; the pedal shell follows the active loader. Selecting a PNAM model rebrowses the editor so model-dependent `p1..pN` labels/ranges appear, and switching type with an empty PNAM slot selects the first available model like the Python client. |
| 18 | Device uploads were preview-only; the picker never called the Rust uploader. | Fixed: the Library file picker and native drag-drop now resolve real paths, call `preflight_upload`, let the user choose a slot, run `begin_upload`, stream `device://upload` ACK progress, cancel after the current chunk, and apply the returned snapshot so the new slot is highlighted. The browser demo keeps its simulated queue. |
| 19 | A minimal stub `.nam` was accepted and could reach the pedal’s loader. | Fixed: preflight now validates that NAM/PNAM files are JSON objects with an architecture, config, numeric weights, and a valid sample rate; malformed IR WAVs are decoded before upload. The target must be a `nam`, `pnam`, or `ir` capture list, so no other list or wrong-kind target can be written. |
| 20 | A legitimate NAM v0.7 A2 file was rejected as “no weights.” | Fixed: A2 `SlimmableContainer` keeps weights in `config.submodels`, not top-level `weights`. Validation now recurses through `config.models`/`config.submodels`, unwraps `{ "model": ... }` entries, and accepts object-map container forms. IR preflight also accepts WAVs larger than the decoded 8 KiB slot. |
| 21 | IR upload was blocked because firmware reports the list type as `wav_48000`. | Fixed: capture-list matching accepts exact types plus rate-tagged variants (`wav_*`, `ir_*`, `nam_*`, `pnam_*`) and untyped known lists, while still rejecting wrong-kind and unknown targets. |
| 22 | The official app and Python client have Clear Chain; the Tauri Board did not. | Added a Board “Chain…” menu with a destructive confirmation. `ChainEdit::Clear` writes one router payload that removes every movable block while preserving fixed blocks and links. Covered by a Rust layout test, CLI simulator smoke, demo-store test, and UI smoke. Hardware pass still pending. |
| 23 | Lists had no delete action; the official app deletes via a zero-fill `dwrite`. | Added per-row delete buttons in the patch rail, Library presets tab, and NAM/PNAM/IR tables. Confirmation names the slot and warns if it is active/current. The backend sends the official `dwrite <list>:{"index":N,"chunk":-1,"value":"00"*128}`, validates the list/index, and reads the list back to verify the slot cleared. Covered by Rust, store, simulator, and UI tests; hardware delete semantics still need manual validation. |

> Device-write incidents, format invariants, and the update-mode recovery
> playbook are now maintained in
> [`DEVICE_SAFETY.md`](DEVICE_SAFETY.md). Read it before any hardware write.

## This pass — live updates

- Interim Tauri poller implemented: 500 ms `read root`, 2 s full browse on TCP,
  `device://snapshot` events, `device://error` on sustained failure, and a
  polling pause while an upload holds the transport.
- UI event listener applies live master, meters, EQ, preset, list, and block
  on/off updates; a changed preset/chain triggers the full editor rebrowse.
- Snapshot polling has not yet been validated for 10 minutes of hardware idle
  time; that remains on the hardware checklist.
- Local capture indexing is implemented in Rust and the browser directory
  picker. Local entries and native-picked files now preflight against the
  connected device and upload through the ACK path; the simulated browser queue
  remains available without hardware.
- Save now persists chain and parameter edits: the wire order is `value` then
  `save`, coalesced writes are flushed first, and the dirty flag survives a
  board refresh. Verified with a reversible hardware test.
- Chain add/remove were exercised on hardware during the save test. The UI
  Remove and Replace actions use the same router write path.
- Parametric NAM now follows the active `pmodel` loader; model-dependent
  `p1..pN` controls load after a model change and the first PNAM model is
  selected automatically when needed.

## Android

- Tauri Android project generated under `apps/desktop/src-tauri/gen/android`;
  `MainActivity` acquires a Wi-Fi `MulticastLock` for mDNS.
- Mobile build disables the desktop `serialport` dependency and uses a
  compile-only stub. The app is Wi-Fi/TCP only; USB serial/OTG is not exposed.
- `scripts/build-android.sh` builds, zipaligns, and signs an APK. Artifacts are
  under `dist/android/` (gitignored).
- Release APKs build for `aarch64` and `x86_64`; the x86_64 release was run in a
  Pixel 10 Pro API 37 emulator and loaded the full simulator board over TCP.
- Android UI harness added under `apps/desktop/ui/e2e/android/` with
  `./scripts/android-e2e.sh` for a fast Playwright/CDP smoke and an
  Appium/UiAutomator2/WebdriverIO suite. The emulator suite covers launch,
  connect, a real parameter edit + save, and Android Back closing overlays.
- Android Back now closes the topmost web overlay instead of exiting the app.
  The connection sheet footer is fixed while its body scrolls so
  Connect/Disconnect stay reachable on phones.
- Remaining UI-test work: physical-phone run, rotation/background/native
  file-picker specs, a typed-knob Appium test, Android-specific visual
  baselines, and a CI emulator job.
- Remaining Android work: physical-phone Wi-Fi/mDNS test, Play Store
  AAB/upload-key signing, tablet/landscape layout, USB-OTG serial (optional),
  reconnect-on-resume, and the Android 17 `ACCESS_LOCAL_NETWORK` runtime request
  before moving `targetSdk` from 36 to 37.
- Details: [`docs/ANDROID.md`](ANDROID.md) and
  [`docs/ANDROID_UI_TESTING.md`](ANDROID_UI_TESTING.md).

## Verified on hardware (2.4.4, 2026-11-20)

- Wi-Fi mDNS discovery and auto-connect from the installed release.
- Reversible Noise Gate bypass write/readback/restore.
- Preset save after a router edit and parameter change, with fresh-read
  verification; original preset restored.
- Chain add/remove during that test.
- Parametric NAM drive editor mapping: PNAM loader, shell model, and
  model-dependent controls confirmed working.

Open hardware checks remain in the section below.

## Local installation

- Installed release build at `~/.local/bin/stompstation`, desktop entry and
  hicolor icons under `~/.local/share`. The release uses Tauri's
  `custom-protocol` feature and embeds the production UI.
- Re-run `scripts/install-local.sh` after changes. GitHub Actions now builds
  Windows NSIS/MSI and Linux deb/AppImage artifacts; signing and an updater
  remain Phase 4.

## Next development

The prioritized order for all remaining implementation, validation, and release
work is in [`REMAINING_WORK.md`](REMAINING_WORK.md).

### Device layer

1. **Single-owner actor.** Implemented: one command queue and scheduler own the
   `Device`, all writes carry a connection generation, polling pauses around
   writes/uploads, snapshots have monotonic actor revisions, and reconnect uses
   capped exponential backoff. A stale write queued before a reconnect is
   rejected. Revisioned patches remain for the conflict UX below.
2. **External-change conflict UX.** Implemented: per-block control hashes feed
   monotonic revisions, pending control/master/EQ writes are tracked, a
   conflict bar offers “Use device” or “Keep local”, and writes rejected after
   reconnect revert the optimistic value. Hardware external-change validation
   remains.
3. **Device-mode undo/redo.** Implemented as a typed device-operation log:
   controls, models, bypass, master, EQ, and router edits replay their inverse
   through the actor; rapid knob writes coalesce. Hardware validation remains.
4. **Upload hardware validation.** The picker → preflight → `begin_upload`
   path, ACK progress, cancel boundary, refreshed target list, and new-slot
   highlight are wired. Basic NAM A2, PNAM, and IR uploads succeeded on 2.5.3;
   A1 is covered by validator/simulator tests but still needs a hardware pass.
   Remaining checks are A1 hardware, cancel-after-ACK, overwriting a used slot,
   and audio readback.
5. **Settings discovery panel.** Launch/manual discovery and the Settings
   re-scan/manage surface are implemented: real serial-port and mDNS results,
   direct connect, connection summary, and a manual TCP field. Physical USB
   replug behavior still needs the hardware pass.
6. **Factory reset recovery.** After reset, clear cached views, rebrowse, and
   show the post-reset state without losing diagnostics.

### UI polish

No open items from the P3 pass. Future polish should start from a new UX review
rather than the completed accessibility, density, virtualization, drawer, and
baseline checklist.

### Hardware validation still open

- Upload NAM/PNAM/IR to a scratch slot and verify the final marker/ACK path.
- Unplug/replug mid-poll and verify reconnect without stale writes.
- Change a preset/chain on the pedal while the app is open.
- Tuner open/close restore.
- EQ writes and chain move/link writes. Chain add/remove are hardware-tested;
  move/link share the same wrapped router payload but have not been exercised
  through the UI.
- Memory/poll stability over 10 minutes.
- Factory reset only with a verified backup.
