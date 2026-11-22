# Remaining work — recommended delivery order

Last updated: 2026-11-22

Sources: [`README.md`](../README.md) status, [`BACKLOG.md`](BACKLOG.md),
[`HARDWARE_VALIDATION.md`](HARDWARE_VALIDATION.md), and
[`DEVICE_SAFETY.md`](DEVICE_SAFETY.md).

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
- [ ] Upload cancel after the second ACK; verify the slot list is unchanged.
- [ ] Overwrite a used capture slot.
- [ ] Delete one preset, NAM, PNAM, and IR entry; verify the slot empties,
      indices do not shift, and deleting an active/current item is safe.
- [x] Clear Chain; fixed blocks and connectors remain (user-confirmed).
- [ ] EQ writes and chain move/link writes.
- [x] Ten-minute idle polling (v0.4.0 read-only pass: 1,179 reads, 0 errors,
      post-run snapshot unchanged).
- [x] Tuner open/close (v0.4.2, 2.5.3: X, T, and Esc all write OFF, including
      when the tuner was already on before opening).
- [ ] USB unplug/replug and external preset/chain change.

Why first: these writes are already exposed in the app. Their real firmware
semantics (especially delete and Clear Chain) must be confirmed before adding
multi-select or more destructive actions.

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

- [ ] Add selection to the preset/Library list inspector.
- [ ] Confirm once, then send one delete per selected index, awaiting each.
- [ ] Refresh after the batch and preserve stable indices.
- [ ] Hardware-check a two- or three-item batch delete.

Prerequisite: 0.2 single-item delete verified on hardware.

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
operations still needs a hardware pass.

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

- [ ] Performance budgets (startup, idle memory, upload memory).
- [ ] Reconnect chaos tests and stale-write checks.
- [ ] WebKitGTK distro matrix (Ubuntu, Fedora, Arch/CachyOS).
- [ ] Confirm Windows NSIS/MSI and both macOS builds on clean machines.
- [ ] Windows code signing.
- [ ] macOS Developer ID signing and notarization.
- [ ] Signed updater and update channel.
- [ ] Crash-report opt-in and diagnostic export review.
- [ ] Final version-source CI guard from 0.3.

Exit: signed installers on Linux/Windows/macOS, budgets met or documented, no
P1 defects.

## P5 — Android, beta, and 1.0

### Android

- [ ] Physical-phone Wi-Fi/mDNS test.
- [ ] Play Store AAB and upload-key signing.
- [ ] Tablet/landscape layout.
- [ ] Reconnect-on-resume.
- [ ] Android 17 `ACCESS_LOCAL_NETWORK` runtime permission.
- [ ] Optional USB-OTG serial.

### Beta and 1.0

- [ ] External beta with real pedal users.
- [ ] Opt-in telemetry and crash triage.
- [ ] Documentation and migration notes.
- [ ] Release candidate and rollback path.
- [ ] 1.0 tag with checksums and artifacts.

## Suggested next three

1. Finish the remaining backed-up hardware validation: cancel-after-ACK,
   overwrite, single-item delete, EQ writes, chain move/link, USB unplug/replug,
   external changes with a pending edit, and device undo/redo.
2. Start P3 with the WCAG contrast audit and axe-core/keyboard checks.
3. P3 is complete; move to P4 hardening and release engineering.

Those three unblock the release and close the highest-value safe gaps before
the device-actor work begins.
