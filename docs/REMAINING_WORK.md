# Remaining work — recommended delivery order

Last updated: 2026-11-27

Sources: [`DEVELOPMENT.md`](DEVELOPMENT.md#project-status) status,
[`BACKLOG.md`](BACKLOG.md), [`HARDWARE_VALIDATION.md`](HARDWARE_VALIDATION.md),
and [`DEVICE_SAFETY.md`](DEVICE_SAFETY.md).

The order below is chosen to reduce risk first, finish visible gaps while the
device layer is stable, then take on the larger architectural work. Android and
1.0 follow once desktop behaviour is settled.

## P0 — Unblock releases and validate new writes

These are gates, not new feature work. Do them before building more on top.

### 0.1 Push the CI Rust setup fix and publish 0.2.0

- [x] Commit/push the workflow change that uses the runner’s installed Rust and
      retries toolchain/target installs.
- [x] Confirm all four matrix jobs pass, especially macOS x64 Intel.
- [x] Confirm the release job creates `v0.2.0` and publishes the four bundles.

Why first: the previous run failed at macOS Intel `Set up Rust` on a transient
DNS error, so the release job was skipped and `v0.2.0` was never created.

### 0.2 Hardware-validate the new write features

Test on a scratch/backed-up state. No factory reset without a fresh backup.

- [x] NAM A1 upload to a free amp slot (user-confirmed on 2.5.3).
- [x] Upload cancel after the second ACK; verify the slot list is unchanged
      (validated 2026-11-26).
- [x] Overwrite a used capture slot (validated 2026-11-26).
- [ ] Delete one preset, PNAM, and IR entry (NAM delete/readback passed on
      2026-11-25); verify the slot empties, indices do not shift, and deleting
      an active/current item is safe.
- [x] Clear Chain; fixed blocks and connectors remain (user-confirmed).
- [x] EQ writes and chain move/link writes (user-confirmed, authenticated pass
      2026-11-25).
- [x] Ten-minute idle polling (v0.4.0 read-only pass: 1,179 reads, 0 errors,
      post-run snapshot unchanged).
- [x] Tuner open/close (v0.4.2, 2.5.3: X, T, and Esc all write OFF, including
      when the tuner was already on before opening).
- [ ] USB unplug/replug and external preset/chain change.

Why first: these writes are already exposed in the app. Their real firmware
semantics (especially delete) must be confirmed before adding multi-select or
more destructive actions.

### 0.3 Release version consistency

- [x] Make the About screen and diagnostics use Tauri’s real app version instead
      of separate hardcoded/Cargo sources.
- [x] Fail the release job when a pushed `v*` tag does not match
      `v<tauri.conf.json version>`.
- [x] Optionally check the workspace Cargo and UI package versions in CI.

This prevents a release tag, bundle filename, and in-app version from drifting
apart.

## P1 — Close small functional gaps

These are user-visible, mostly isolated changes that do not need the device
actor.

### 1.1 Save As dialog

- [x] Add a Save As action beside rename.
- [x] Use the existing `save_preset(name)` core and name validation.
- [x] Add duplicate-name rejection, post-save list refresh, and dirty-state
      handling.
- [x] Hardware-validate Save As to a new slot. The firmware creates a new preset;
      overwrite is not supported and is intentionally not needed.

Why now: the core already supports it; this is the lowest-risk visible gap.

### 1.2 Multi-select list deletion

- [x] Add selection to the preset/Library list inspector.
- [x] Confirm once, then send one delete per selected index, awaiting each.
- [x] Refresh after the batch and preserve stable indices.
- [x] Hardware-check a two- or three-item batch delete (user-confirmed).

Prerequisite: 0.2 single-item delete verified on hardware (NAM passed;
preset/PNAM/IR single deletes remain open).

### 1.3 Factory reset flow

- [ ] Wire the existing Rust factory-reset command to the Settings dialog.
- [ ] Keep the typed `RESET` confirmation and consequence list.
- [ ] After success, clear cached views, rebrowse, and show the empty/post-reset
      state without losing diagnostics.
- [ ] Require a verified backup in the documented procedure.
- [ ] Hardware-test only with a fresh backup and a recovery plan.

Why here: the backend exists, but this is destructive and should follow the
delete/clear hardware validation.

### 1.4 Tuner fallback polish

- [x] Poll only while the tuner is open (already mostly true).
- [x] Read live frequency/level/reference from the `tuner\tuner` module and
      compute note/cents.
- [x] Serialize tuner polls so a slow read cannot delay close.
- [x] Closing always writes OFF; opening is idempotent across duplicate opens.
- [x] Hardware-validated opening, toggling, and closing the tuner on 2.5.3
      with v0.4.2.
- [x] Handle firmware without a tuner node gracefully instead of surfacing a
      write error.

### 1.5 Settings discovery surface — optional

- [x] Replace the placeholder Settings scan button with real mDNS/USB discovery.
- [x] Show transport, address, device name, firmware, and a manual TCP field.

The connection sheet already discovers and connects; this is an optional
manage/re-scan surface.

## P2 — Device architecture

This is the largest remaining block. Do it after the small gaps so the actor
does not block visible improvements.

### 2.1 Full single-owner device actor

- [x] Replace `Mutex<Device>` plus the interim poller with one command queue.
- [x] Add a scheduler, revisions/patches, reconnect backoff, and explicit
      pending-write tracking.
- [x] Pause/resume polling around uploads and destructive writes.
- [x] Keep the existing simulator, command API, and UI snapshot contract.

Exit: reconnect and external-change behaviour are deterministic; no stale write
survives a reconnect. Simulator and unit tests cover connect/read/write,
monotonic revisions, backoff, and stale-write rejection; unplug/replug remains
in the 0.2 hardware pass. Snapshot revisions are monotonic across reconnects;
diff/patch events are part of 2.2.

### 2.2 External-change conflict UX

- [x] Detect changed preset/router/control values via revisions.
- [x] Show “Changed on device — board reloaded.”
- [x] If a local write is pending, mark the affected control and let the user
      choose the device or local value.
- [x] Roll back pending state on reconnect if the write was lost.

Depends on 2.1. Per-block control hashes feed monotonic actor revisions;
pending writes are tracked per control/master/EQ value, a conflict bar offers
“Use device” or “Keep local”, and stale writes rejected after reconnect revert
the optimistic value and refresh. Simulator/unit tests cover the store rules;
the external-change hardware pass remains in 0.2.

### 2.3 Device-mode undo/redo

- [x] Record actual device operations, not just UI snapshots.
- [x] Replay the changed controls/router writes on undo/redo.
- [x] Coalesce rapid knob writes into one undo entry.

Depends on 2.1 and the conflict rules from 2.2. Device edits now push a typed
operation log (control, model, bypass, master, EQ, router move/add/remove/
replace/link/clear); undo/redo replays the inverse through the actor, blocks
while conflicts are unresolved, flushes pending coalesced writes first, and
clears history on reconnect or a preset/chain reload. Undo of router and EQ
operations were validated on 2026-11-26.

## P3 — UI, accessibility, and polish

Do this before signing/notarization so visual baselines and accessibility are
part of the release candidate.

- [x] WCAG contrast audit for all three themes. Cream and British Green
      secondary/accent tokens were darkened to reach AA contrast.
- [x] Add axe-core smoke coverage for every view, all three themes, the tuner,
      command palette, connection sheet, activity drawer, and preset/chain
      dialogs.
- [x] Complete the keyboard-only pass: skip link, ARIA tabs with arrow/Home/End
      navigation, focus return from dialogs, and global shortcuts while knobs
      own focus.
- [x] Run axe and keyboard smokes in CI.
- [x] Density pass: Type and Model share a compact selector row, repeated
      model/group labels are gone, inspector spacing is tighter, and the
      utility rail has one activity action instead of two.
- [x] Add focused, pending, conflict, and error visual-state checks with axe
      scans in all three themes.
- [x] Virtualize the capture and local-file tables above 80 rows. The UI smoke
      loads a 240-file folder, checks that only visible rows mount, and scrolls
      to the last capture.
- [x] Add a narrow-window preset drawer. The title bar exposes a Patches button
      below 860 px; selecting a preset closes the drawer, Escape closes it and
      returns focus, and axe/keyboard smokes cover it.
- [x] Add compact-chain mode: an Appearance toggle renders two knobs per shell
      and a model-only amp plate with narrower shells.
- [x] Add visual regression baselines for Board, Amp room, EQ, Library,
      Settings, Stage, and tuner in all three themes (21 screenshots). The
      comparison runs in CI; update baselines with `pnpm test:visual:update`.

## P4 — Hardening and release engineering

- [x] Startup, first-paint, DOM-node, and idle-heap budgets in CI. Local
      reference run: 643 ms ready, 24 ms FCP, 2,104 nodes, 6.3 MiB idle heap,
      0.0 MiB growth over 3 s.
- [x] Prepared-upload buffer budget for a 2 MiB incompressible PNAM: the
      hex/name chunks stay within 2x payload plus overhead.
- [ ] Measure peak process RSS during a real large-file upload on hardware.
- [x] Reconnect chaos and stale-write tests: stale generations are rejected
      before touching the device, and rapid reconnect losses keep generation
      monotonic with capped backoff.
- [ ] WebKitGTK distro matrix (Ubuntu, Fedora, Arch/CachyOS).
- [ ] Confirm Windows NSIS/MSI and both macOS builds on clean machines.
- [ ] Windows code signing.
- [ ] macOS Developer ID signing and notarization.
- [ ] Signed updater and update channel.
- [x] Diagnostic export review: Copy report now uses the real backend, the
      visible summary reflects the active connection, clipboard failures fall
      back safely, and the UI states that crash reporting is off with no
      telemetry.
- [ ] Add an opt-in crash-reporting/telemetry pipeline.
- [x] Final version-source CI guard from 0.3 (workspace, UI package, and
      Tauri config versions must match).

Exit: signed installers on Linux/Windows/macOS, budgets met or documented, no
P1 defects.

## Next release — 0.6.0

The next feature set is tracked in [`V0.6.0_PLAN.md`](V0.6.0_PLAN.md):
input settings, Preset Level, Add-block scrolling, the Parametric EQ graph,
preset export/import, Library downloads, and Library rename.

All eight items are implemented and covered by simulator/Rust tests, Vitest,
UI smoke, axe, keyboard, and visual baselines. The official local `Brave.zip`
imports into the simulator and its read-back `.pst` is byte-identical.

Live 2.5.3 verification on 2026-11-23 confirmed the IR slot payload is 8192
bytes of raw `f32` samples (not WAV); the app now wraps it in the official
8248-byte float-WAV container. A live `Brave` export matched the official
`Brave.zip` `.pst` and all four dependency hashes byte-for-byte.

The remaining 0.6.0 gate is hardware validation: import
`used`/cancelled-dependency semantics, the used-capture rename policy, and the
full Library download UI pass. Input gain, Preset Level, Parametric EQ writes,
the import commit, and duplicate-name behavior are validated on 2.5.3. See
[`REMAINING_VALIDATION.md`](REMAINING_VALIDATION.md) V12–V14.

## P5 — Android, beta, and 1.0

### Android

- [x] Emulator UI harness: Playwright/CDP smoke plus Appium/UiAutomator2/
  WebdriverIO for launch, connect, parameter edit + save, and Android Back.
- [ ] Physical-phone UI suite (Wi-Fi/mDNS and manual address).
- [x] Rotation, background/resume, and native file-picker specs.
- [x] Typed-knob test through Appium `setValue`/`sendKeys`.
- [x] Android visual baselines reviewed; decided against separate baselines
      (browser baselines + Android geometry/screenshot artifacts).
- [x] CI emulator job for the UI suite.
- [ ] Physical-phone Wi-Fi/mDNS test.
- [x] Play Store AAB build and upload-key signing path (script supports
      `release aab` + `STOMPSTATION_KEYSTORE`; a real upload key is user-supplied).
- [x] Tablet/landscape layout (short-window board scroll and compact chrome).
- [x] Phone UX: wrapped knob-free chain overview, full-height block editor,
      centered connection sheet, labeled tabs, and Amp room omitted from mobile
      navigation.
- [x] Reconnect-on-resume.
- [x] Android 17 `ACCESS_LOCAL_NETWORK` runtime permission.
- [ ] Optional USB-OTG serial.
- UI harness and remaining test work:
  [`ANDROID_UI_TESTING.md`](ANDROID_UI_TESTING.md).

### Beta and 1.0

- [ ] External beta with real pedal users.
- [ ] Opt-in telemetry and crash triage.
- [ ] Documentation and migration notes.
- [ ] Release candidate and rollback path.
- [ ] 1.0 tag with checksums and artifacts.

## Suggested next three

1. Finish the remaining backed-up hardware validation: preset/PNAM/IR single
   delete (NAM passed; multi-item batch deletion is user-confirmed), USB
   unplug/replug, external changes with a pending edit, and audio readback.
   Follow [`REMAINING_VALIDATION.md`](REMAINING_VALIDATION.md).
2. Continue P4: upload-memory budget, distro/clean-machine checks, signing,
   updater, and crash-report/diagnostic review.
3. Then Android/beta work in P5.

Those three unblock the release and close the highest-value safe gaps before
the device-actor work begins.
