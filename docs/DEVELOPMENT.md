# Development guide

Technical companion to the root [README](../README.md). It covers the
architecture, project status, local development, tests, and the release
pipeline. User-facing download, install, and usage notes stay in the README.

## Architecture

The project is deliberately split into two worlds:

- **Rust core** — framing, node cache, router, presets, editor derivation,
  upload codecs, EQ math, transports, simulator, and tests.
- **React + Tauri shell** — a pedalboard-first interface that consumes typed
  view models and never owns a socket.

The device core is a single-owner actor: it owns polling, reconnect backoff,
and monotonic snapshot revisions. The UI sends typed commands; the shell
forwards them to the actor. Wi-Fi and USB use the same transport contract.
The deterministic simulator and the browser demo implement the same protocol
without hardware.

## Project status

| Area | State |
| --- | --- |
| Phase 0 — protocol freeze | Core ported and tested; simulator + hardware fixtures; Python/Rust differential is clean on 2.4.4 and live 2.5.3 |
| Phase 1 — walking skeleton | Tauri commands, USB/TCP transports, browse, writes, presets, chain edits, snapshot mapping, real connect path; the single-owner actor owns polling, reconnect backoff, and monotonic snapshot revisions; reversible gate write/readback/restore passed on hardware; launch discovery is Wi-Fi → USB with an explicit no-device state |
| Phase 2 — design system & board | Design tokens, three themes, component kit, Board, Amp room, Global EQ, Library, Settings, Stage mode, command palette, tuner deck, responsive layouts |
| Phase 3 — deep parity | Uploads are wired end-to-end for NAM, Parametric NAM, IR, and the legacy VXAMP list: native picker, device preflight with model/WAV structural validation, capture-list guard, slot selection, ACK progress, cancel-after-current-chunk, and refreshed-list highlighting. Both NAM A1 (flat WaveNet/LSTM weights) and NAM A2 (`SlimmableContainer` submodels) are supported and covered by validator/simulator tests; NAM A1, NAM A2, PNAM, and IR uploads are validated on 2.5.3, including the `wav_48000` IR list type. VXAMP is uploaded as an opaque, zero-padded 12 KiB raw payload and has been tested working on hardware. Upload cancel-after-ACK and overwrite paths are validated on 2.5.3; audio readback remains. Preset save, chain add/remove, Wi-Fi discovery, and the Parametric NAM editor are hardware-validated on 2.4.4; 2.5.3 PNAM switches and multi-client Wi-Fi were verified live |
| Live updates | Single-owner device actor emits snapshots every 500 ms, with a 2 s browse on TCP; uploads pause polling |
| Local library | Sectioned Amps/Drives/IRs browser with NAM/Parametric NAM/VXAMP subsections, recursive `.nam`/`.pnam`/`.wav`/`.vxamp` folder indexing, preflight, and target/format validation |
| List deletion | Per-row delete in the patch rail and Library lists, plus multi-select delete in the Library lists, use the official zero-fill `dwrite` with confirmation and read-back verification; NAM delete and multi-item batch deletion are user-confirmed, while single-item preset/PNAM/IR deletion remains simulator/UI-tested only |
| Chain editing | Remove, replace, and clear use one router write per action; add/remove/replace/move/link/clear are covered by the simulator smoke. Clear chain preserves fixed blocks and connectors behind a destructive confirmation. The chain write payload is wrapped as `{"value": ...}` so the firmware accepts it |
| Preset save | Saves the live chain and parameter edits; JSON field order matches the device (`value` before `save`), coalesced writes flush first, and router edits keep the preset dirty until saved |
| Global input settings | Settings → Audio & pedal reads/writes `gain1`/`gain2` (−15…+15 dB, 0.1 steps) and displays the read-only `_connected1`/`_connected2` jack state. Gain writes are global and do not mark the preset dirty |
| Preset Level | Uses firmware 2.5.3's `root\app\output\pst\level` (−20…+20 dB); the lower-bar stepper tracks the snapshot's range, supports 0.5 dB buttons and 0.1 dB arrow-key steps, and stays on the existing dirty/save path |
| Parametric EQ graph | The in-chain `root\app\parametric_eq` block gets the shared Global EQ graph with four draggable/keyboard bands, Q wheel, selected-band highlighting, Flat reset, and numeric cards. The 8-band Graphic EQ and Global EQ paths are not reused |
| Preset bundles | Export writes the device's stored `.pst` plus every `root\presets.used` dependency to the official `bdinfo.json`/`preset/`/`dependencies/` zip shape. The live `Brave` export now matches the official `Brave.zip` byte-for-byte for the `.pst` and all four dependencies. Import validates paths, manifest, `.pst` scope, NAM/PNAM/IR structure, duplicate/missing dependencies, duplicate preset names, and free-slot capacity for every capture list before writing; VXAMP dependencies use raw non-empty/size checks. Identical captures are reused, multiple new captures reserve distinct slots, preset slots use the name → data → name commit sequence, and partial writes are reported |
| Library downloads | NAM/PNAM downloads consume `dread` chunks from 1, decompress gzip, trim slot padding, and validate the model; IR slots return 2048 raw little-endian `f32` samples, which the app wraps in the same 48 kHz mono float WAV header the official app exports; VXAMP returns the raw padded slot payload. Progress is cancellable at chunk boundaries and writes use a temp file |
| Library rename | Renames use the 128-byte `dwrite` name chunk with readback and duplicate validation. Captures referenced by `root\presets.used` are blocked with the affected preset names until the firmware reference-update behavior is verified on hardware |
| Add-block menu | Capped at `min(60vh, 440px)` with internal scrolling, collision padding, Radix type-ahead/keyboard navigation, and an 800×600 Playwright check |
| Hardware-verified | Gate toggle/restore, preset save with chain + parameter changes, chain add/remove, Wi-Fi auto-discovery, the PNAM drive editor, and a VXAMP raw-list upload have been exercised on hardware. Firmware 2.4.4 covered gate, preset, chain, discovery, and PNAM editing; firmware 2.5.3 was checked live for the 694-node tree, PNAM switch controls, simultaneous Wi-Fi clients, and NAM A1/A2/PNAM/IR uploads. On 2026-11-23, live 2.5.3 reads confirmed IR slots are raw `f32` payloads, and a live `Brave` export matched the official `Brave.zip` `.pst` and dependency hashes. On 2026-11-25, the authenticated hardware pass also covered preset save, chain move/link, EQ writes, tuner, NAM delete/readback, rename, and downloads. On 2026-11-26, upload cancel/overwrite, device undo/redo, input gain, Preset Level, and Parametric EQ writes were validated. Multi-item batch deletion is user-confirmed. Audio readback, external-change handling, and unplug/replug remain open |
| Android | Wi-Fi/TCP-only Tauri app; targetSdk 37 with the runtime local-network permission, content-URI file-picker bridge, background/resume reconnect, and compact landscape layout. APK and AAB builds/signing paths exist, and a CI Appium emulator suite covers smoke, typed-knob, rotation, resume, and native file-picker upload. USB-OTG and physical-phone validation remain; see [`ANDROID.md`](ANDROID.md) |
| Local install | `scripts/install-local.sh` installs the release binary, desktop entry, and icons; rerun to update |
| Update check | Settings → About reads the public GitHub releases feed, compares the latest tag with the running build, and opens the release page in the default browser. It does not download or install updates |
| Phase 4–5 — hardening/release | P4 in progress: performance budgets, stale-write chaos tests, and diagnostic export review are in place; distro/clean-machine checks, signing, updater, and crash telemetry remain |

The 0.6.0 work in [`V0.6.0_PLAN.md`](V0.6.0_PLAN.md) is implemented:
input gain/connection settings, Preset Level, the scrolling Add-block menu, the
Parametric EQ graph, preset export/import, Library file downloads, and Library
file renaming. The simulator, Rust/unit tests, UI smoke, accessibility, keyboard,
and visual baselines cover the new paths; hardware validation is the remaining
gate, especially Library download bytes, the used-capture rename policy, and
import `used`/cancelled-dependency semantics. Input gain, Preset Level,
Parametric EQ writes, preset-bundle import/commit, and dependency reuse were
validated on 2.5.3.

The browser build runs against a deterministic demo device so every surface is
inspectable without hardware. The Tauri shell starts disconnected: it scans
mDNS `_http._tcp` for a VoidX device first, then probes USB serial ports, and
opens the connection sheet with a clear error if neither finds a pedal. The
demo board in the Tauri shell is opt-in with `--demo` (or
`STOMPSTATION_DEMO=1`); manual Wi-Fi/TCP and USB remain available in the sheet.

The board is live: parameter and router writes change the pedal immediately.
**Save** persists that live state into the current preset. The Save button stays
disabled until something is dirty; a refresh never clears the dirty flag, and
pending coalesced knob/model writes are flushed before the save command.

Hardware notes, the differential results, and the remaining hardware checklist
live in [`HARDWARE_VALIDATION.md`](HARDWARE_VALIDATION.md). The step-by-step
remaining pass is in [`REMAINING_VALIDATION.md`](REMAINING_VALIDATION.md).
Firmware 2.5.3 verification and the client-side changes it required are in
[`FIRMWARE_2.5.3.md`](FIRMWARE_2.5.3.md).

Before adding a device write or running a hardware upload test, read
[`DEVICE_SAFETY.md`](DEVICE_SAFETY.md). It records the 2026-11-22 soft-brick
caused by a synthetic NAM upload, the format/list invariants that prevent a
repeat, and the recovery playbook for update mode.

The official VoidX-Control list-delete behavior is documented in
[`voidx-delete-button-behavior.md`](voidx-delete-button-behavior.md). The
prioritized plan for the remaining work is in [`REMAINING_WORK.md`](REMAINING_WORK.md).

## Repository layout

```text
.
├─ .github/workflows/          # desktop + Android release builds and Android UI tests
├─ Cargo.toml                  # Rust workspace
├─ crates/
│  ├─ stomp-protocol/          # frame parsing, commands, NodeStore, router,
│  │                           # presets, editor derivation, pfloat, labels
│  ├─ stomp-transport/         # Transport trait, serialport, TCP, scripted replay
│  ├─ stomp-device/            # single-owner Device core, view models, uploads
│  ├─ stomp-upload/            # NAM/PNAM/IR/VXAMP codecs + ACK state machine
│  ├─ stomp-eq/                # RBJ biquads + response evaluation at 48 kHz
│  ├─ stomp-sim/               # deterministic fake pedal over TCP
│  └─ stomp-cli/               # probe, dump, fixture, replay, upload, bench
├─ apps/desktop/
│  ├─ src-tauri/               # Tauri 2 app, typed commands, state
│  │  └─ gen/android/          # Tauri Android project (source; build outputs ignored)
│  └─ ui/                      # React 19 + TypeScript + Vite, design system
│     └─ e2e/android/          # Appium/UiAutomator2 + WebdriverIO Android suite
├─ docs/                       # development, Android, safety, validation, screenshots
├─ fixtures/
│  └─ snapshots/               # generated snapshot + block editors
├─ Legacy/                     # original Python GTK client and protocol notes
├─ packaging/                  # Linux desktop entry and udev rule
└─ scripts/
   ├─ smoke.sh                 # simulator -> core -> assertions
   ├─ auth-smoke.sh            # password/token simulator -> CLI assertions
   ├─ build-android.sh         # APK build + zipalign + sign
   ├─ android-release-keystore.sh # release key + GitHub secret setup
   ├─ android-e2e.sh           # Android UI tests (CDP + Appium)
   ├─ install-local.sh         # desktop release install/update
   └─ dev.sh                   # Vite + Tauri dev shell
```

## Development setup

### Prerequisites

- Rust stable (the workspace pins `rust-version = 1.89`).
- Node.js 22+ and pnpm 12.
- Tauri's Linux build dependencies. On Debian/Ubuntu:

  ```bash
  sudo apt update
  sudo apt install -y \
    libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf \
    libgtk-3-dev libudev-dev libssl-dev libxdo-dev pkg-config
  ```

  `libudev-dev` is required by the Rust `serialport` crate used for USB pedal
  access.

- The Tauri CLI:

  ```bash
  cargo install tauri-cli --version '^2'
  ```

- For Android, see [`ANDROID.md`](ANDROID.md). It covers the JDK, SDK, NDK,
  Rust targets, and signing prerequisites.

### Run the UI

```bash
cd apps/desktop/ui
pnpm install
pnpm dev          # http://127.0.0.1:1420
pnpm build        # production bundle (required before the Playwright smokes)
pnpm lint         # TypeScript project check
pnpm test         # unit + mapping tests (Vitest)
pnpm test:ui       # Playwright interaction smoke against the built bundle
pnpm test:mobile   # phone geometry: centered connection sheet, chain editor, no Amp tab
pnpm test:startup  # Playwright startup smoke: Wi-Fi/USB failure, --demo, USB success
pnpm test:a11y     # axe WCAG AA scan: three themes, every view and overlay
pnpm test:keyboard # keyboard-only pass: skip link, tabs, dialogs, knobs, shortcuts
pnpm test:states   # focused, pending, conflict, and error state checks
pnpm test:visual   # compare 21 screenshots against committed baselines
pnpm test:visual:update # regenerate the visual baselines
pnpm test:perf     # startup, paint, DOM-node, and idle-heap budgets
```

Android UI tests run from the repository root against an emulator/device:

```bash
./scripts/android-e2e.sh both   # Playwright/CDP + Appium/WebdriverIO
```

The Playwright smokes start their own Vite preview server. Override the default
ports with `UI_SMOKE_PORT=…` / `STARTUP_SMOKE_PORT=…` if they are already in
use.

The browser preview starts on the simulated board. Press `Ctrl/⌘+K` for the
command palette, `1`–`6` for views, `T` for the tuner, and `Space` to bypass the
selected block.

### Run the desktop shell

The shortest route (starts Vite and the Tauri dev window, from the repository
root):

```bash
./scripts/dev.sh          # auto-discover Wi-Fi, then USB
./scripts/dev.sh --demo   # force the demo board, no hardware search
./scripts/dev.sh --sim    # also start the simulator on 127.0.0.1:45678
```

The connection pill opens the transport sheet: USB `/dev/ttyACM0` for the
pedal, or Network `127.0.0.1:45678` for the simulator.

With the Tauri CLI instead:

```bash
cd apps/desktop/ui
pnpm install
cd ..
cargo tauri dev          # starts Vite on 127.0.0.1:1420 automatically
```

Without the Tauri CLI, start the frontend yourself:

```bash
# terminal 1, from the repository root
cd apps/desktop/ui && pnpm dev

# terminal 2, from the repository root
cargo run -p stompstation-desktop
```

A debug `cargo run` uses the Vite dev URL. For a production-like run:

```bash
cd apps/desktop/ui && pnpm build
cd ../../..
cargo build --release -p stompstation-desktop
./target/release/stompstation-desktop
```

In the connection sheet:

- **USB** — pick `/dev/ttyACM0` (or the enumerated port).
- **Network** — enter `127.0.0.1:45678` to talk to the bundled simulator, or the
  pedal's `host:port`.
- **Use simulator** — in the browser preview, or in Tauri when launched with
  `--demo` / `STOMPSTATION_DEMO=1`.

### Run the core + simulator

```bash
# start the fake device (one per command is fine)
cargo run -p stomp-sim -- --port 45678

# another terminal: snapshot, toggle a block, load a preset, upload
cargo run -p stomp-cli --bin stomp -- dump tcp:127.0.0.1:45678
cargo run -p stomp-cli --bin stomp -- set-block tcp:127.0.0.1:45678 'root\app\amp' off
cargo run -p stomp-cli --bin stomp -- set-control tcp:127.0.0.1:45678 \
  'root\app\drive\gain' 2.5
cargo run -p stomp-cli --bin stomp -- editor tcp:127.0.0.1:45678 'root\app\drive'
cargo run -p stomp-cli --bin stomp -- remove-block tcp:127.0.0.1:45678 0 2
cargo run -p stomp-cli --bin stomp -- add-block tcp:127.0.0.1:45678 0 2 'root\app\pitch'
cargo run -p stomp-cli --bin stomp -- replace-block tcp:127.0.0.1:45678 0 0 'root\app\chorus'
cargo run -p stomp-cli --bin stomp -- preset tcp:127.0.0.1:45678 'Dumble Clean'
cargo run -p stomp-cli --bin stomp -- save-preset tcp:127.0.0.1:45678
cargo run -p stomp-cli --bin stomp -- fixture tcp:127.0.0.1:45678 \
  fixtures/snapshots/simulator-2.4.4.json

# the complete simulator smoke
./scripts/smoke.sh
```

`stomp-cli` also supports `move-block <addr> <from-row> <from-col> <to-row>
<to-col>`, `upload <addr> nam|pnam|ir <file> <slot|-> <target>`, and
`replay <fixture.json>`. `fixture` and `editor` are read-only.

### Install locally

Build the production UI, embed it in the release binary, and install it for the
current user:

```bash
./scripts/install-local.sh
```

That installs:

- `~/.local/bin/stompstation`
- `~/.local/share/applications/stompstation.desktop`
- hicolor icons under `~/.local/share/icons/hicolor/`

Launch **StompStation** from the application menu or run
`~/.local/bin/stompstation`. It searches Wi-Fi first, then USB. Run
`~/.local/bin/stompstation --demo` to open the simulator board without hardware.
Re-run the same script after any change to rebuild and replace the installed
app. The release build uses Tauri's `custom-protocol` feature, so it loads the
embedded UI with no Vite server.

### Android development

The full Android build, signing, install, emulator, and troubleshooting notes
are in [`ANDROID.md`](ANDROID.md). The short version:

```bash
export JAVA_HOME=/opt/android-studio/jbr
export ANDROID_HOME="$HOME/Android/Sdk"
export NDK_HOME="$ANDROID_HOME/ndk/28.2.13676358"

./scripts/build-android.sh aarch64 release   # phone
./scripts/build-android.sh x86_64 release    # emulator
./scripts/build-android.sh aarch64 debug      # debuggable, used by UI tests
```

Outputs land in `dist/android/` (gitignored). Release builds signed without
`STOMPSTATION_KEYSTORE` use the local Android debug key and are for sideloading
only. CI uses a dedicated release keystore; see
[`ANDROID.md#ci-release-and-obtainium`](ANDROID.md#ci-release-and-obtainium).

## Test matrix

Run the fast, hardware-free suite from the repository root:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace          # 124 Rust tests
./scripts/smoke.sh              # simulator -> core -> chain/save/preset/upload assertions
./scripts/auth-smoke.sh         # password/token simulator -> reads/write/upload/download

cd apps/desktop/ui
pnpm lint
pnpm test                       # 99 Vitest tests
pnpm build
pnpm test:ui                    # interaction smoke
pnpm test:mobile                # phone layout/geometry smoke
pnpm test:startup               # no-device / --demo / Wi-Fi-or-USB startup smoke
pnpm test:a11y                  # WCAG AA scans in all themes and overlays
pnpm test:keyboard              # keyboard-only pass
pnpm test:states                # focused/pending/conflict/error states
pnpm test:visual                # screenshot baseline comparison
pnpm test:visual:update         # regenerate baselines after an intended UI change
pnpm test:perf                  # startup, paint, DOM-node, and idle-heap budgets
```

Android packaging is checked separately:

```bash
./scripts/build-android.sh aarch64 release
```

The automated suites never write to hardware. Hardware writes are only part of
manual validation and are listed in [`HARDWARE_VALIDATION.md`](HARDWARE_VALIDATION.md).

### Protocol invariants worth preserving

- Router writes are an object: `write root\app\router:{"value":[[...]]}`.
  A bare matrix is rejected by the firmware and never ACKs.
- Preset saves must serialize `value` **before** `save`:
  `write root\app\preset:{"value":"Name","save":"save"}`. The firmware
  applies fields in order; reversing them reloads the stored preset and
  discards unsaved chain/parameter changes. `serde_json` uses
  `preserve_order` for this reason.
- Editor visibility is type-aware. `model` is the NAM loader, `pmodel` is the
  Parametric NAM loader, and `p1..pN` pfloat controls belong to the active
  PNAM model. The UI must prefer the visible loader, not always `model`.
- Firmware 2.5.3 exposes PNAM switch positions as pfloat nodes whose `vtype`
  style is a JSON array such as `["ON","OFF"]`. The node value is the option
  index normalized to `index / (count - 1)`, not a 0–1 continuous knob.

## Release and CI

The workflows live in [`.github/workflows/`](../.github/workflows/):

- `build.yml` — desktop bundles plus the signed Android APK. Runs on pushes,
  pull requests, tags, and manual dispatch.
- `android-ui.yml` — Appium emulator suite for the Android UI.

### Desktop

| Platform | Packages |
| --- | --- |
| Windows x64 | NSIS installer (`.exe`) and MSI (`.msi`) |
| Linux x64 | Debian package (`.deb`) and AppImage |
| macOS x64 (Intel) | `.dmg` and zipped `.app` |
| macOS arm64 (Apple Silicon) | `.dmg` and zipped `.app` |

Pushes to `master` publish or update the GitHub Release for the version in
`apps/desktop/src-tauri/tauri.conf.json`. To cut a new release, bump that
version and push; an explicit `v*` tag can also be pushed to publish or update
that tag's release. CI fails when the workspace Cargo version, UI package
version, or a pushed `v*` tag disagrees with `tauri.conf.json`.

The Linux AppImage is larger than the Windows bundle because it embeds
GTK/WebKitGTK, while Windows uses the system WebView2 runtime. macOS builds
are ad-hoc signed but not notarized, so Gatekeeper requires right-clicking the
app and choosing **Open** (or removing the quarantine attribute) on first
launch.

### Android APK

The `android` job in `build.yml` builds an arm64 release APK on `master`/`main`
pushes, `v*` tags, and manual dispatch (not PRs). It installs JDK 21, Android
platform 37.0, build-tools 36.0.0, NDK `28.2.13676358`, and the
`aarch64-linux-android` Rust target, then runs
`./scripts/build-android.sh aarch64 release`.

To build and publish only the APK without the desktop matrix, run the workflow
manually with the `android_only` input:

```bash
gh workflow run build.yml --ref master -f android_only=true
```

In the Actions UI, choose **Build and release → Run workflow** and enable
**Build and publish only the Android APK**.

The APK is signed with the repository release keystore, verified
(`package`, `versionName`, `versionCode`, `apksigner verify`), and attached to
the same GitHub Release as the desktop bundles as
`StompStation_<version>_arm64-v8a.apk`. A `.sha256` file is published next to
it. The job fails rather than publish a debug-signed APK when the signing
secrets are missing.

Repository secrets:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Generate the keystore once with
[`scripts/android-release-keystore.sh`](../scripts/android-release-keystore.sh).
Back it up: Android requires every update to be signed with the same key.
Losing it means existing installs cannot be updated. See
[`ANDROID.md`](ANDROID.md#release-signing) for the full setup.

The Android `versionCode` is derived from the app version:
`major × 1_000_000 + minor × 1_000 + patch`. For example, `0.7.0` becomes
`7000`. Obtainium and Android compare the version name and code, so bump
`tauri.conf.json` for every release that users should receive. Rebuilding an
existing version replaces the release asset without prompting installed apps
to update.

## What is ported

- `<command>\r\n\0` framing, NUL and idle-timeout responses, persistent RX
  buffer, first-colon response split, token detection.
- `browse root` replacement snapshots, `read root` deltas, unknown-field
  preservation, double-escaped path normalization.
- Router discovery, 2-D and flat matrices, link markers, fixed positions,
  add/remove/move/link edits, ancestor enabling.
- Preset discovery from `plist` refs, list fallbacks, 63-byte name rules,
  128-byte padded rename chunks.
- Preset save with firmware-sensitive field order (`value` before `save`),
  coalesced-write flush, and a dirty flag that survives board refreshes.
- Block editor derivation: nested folders, modules, tempo-sync groups, model/IR
  selectors, pfloat metadata and display ranges, type-aware NAM/PNAM visibility,
  active `model`/`pmodel` loader selection, dual `nam2`/`ir2` groups.
- NAM/PNAM 1/2 MiB padding + gzip level 6, 128-byte name chunk, 2048-character
  final marker, full-tail marker edge case, IR 2048-sample float32 conversion,
  ACK slot/chunk validation and polling-pause semantics.
- Four-band RBJ EQ response at 48 kHz.
- USB CDC-ACM, TCP, and scripted transports; serial port enumeration.
- Shell knob auto-assignment (priority, aliases, three-knob cap, no phantom
  knobs), theme tokens, and the view models the UI consumes.

## Known gaps / next steps

1. **Revisioned patch stream.** The single-owner actor, monotonic revisions,
   reconnect backoff, and external-change conflict UX are implemented on full
   snapshots. A delta/patch stream remains an optimization for very large
   boards, not a correctness blocker.
2. **Upload hardware validation.** The picker → preflight → `begin_upload`
   path, ACK progress, cancel boundary, refreshed target list, and new-slot
   highlight are wired. NAM A1/A2, PNAM, and IR uploads, cancel-after-ACK, and
   overwrite are validated on 2.5.3; audio readback still needs a hardware pass.
3. **Settings discovery panel.** Launch/manual discovery works (Wi-Fi → USB,
   mDNS list), and Settings now re-scans real serial/mDNS results, shows the
   active transport/address, and accepts a manual TCP target.
4. **Device undo/redo.** Device edits record typed operations and replay inverse
   control/router writes. Undo/redo of control, master, EQ, bypass, and router
   edits passed on 2026-11-26.
5. **Hardware validation.** Upload A1/A2/PNAM/IR, move/link, EQ writes, tuner
   open/close, input gain, Preset Level, Parametric EQ writes, and device
   undo/redo passed on 2.5.3. Ten-minute idle polling passed read-only.
   External-change handling, unplug/replug, and audio readback remain open. See
   the hardware checklist.
6. **Android release.** Physical-phone Wi-Fi/mDNS validation and optional
   USB-OTG serial remain open. Tablet layout and reconnect-on-resume are
   implemented.
7. **Packaging.** GitHub Actions builds Windows NSIS/MSI, Linux deb/AppImage,
   macOS app/DMG, and the Android APK. macOS signing/notarization, an updater,
   and crash-report opt-in remain.
8. **Accessibility audit.** Knobs expose the ARIA slider contract, LEDs have
   text labels, graphs have numeric cards, and focus order follows the chain.
   All three themes pass the WCAG AA axe scan, the keyboard-only pass covers
   every view and overlay, and focused/pending/conflict/error states are
   checked automatically.

## Design notes

- Default theme **Studio Black**; **Cream Tolex** and **British Green** are
  token-only variants. Themes are validated token files in the real app; this
  build ships the three built-ins as CSS token sets.
- DOM + CSS + SVG only. No canvas. Meters use a small `requestAnimationFrame`
  loop outside React state; knobs write local state immediately and coalesce
  device writes at 50 ms in the typed IPC client.
- Every fixed slot has a lock; every LED has ON/OFF text; every EQ graph has
  four numeric band cards; every pointer gesture has a keyboard path.
- `prefers-reduced-motion` and the Appearance → Motion switch remove
  non-essential animation.

## Troubleshooting

- **No device found on launch.** The app tries mDNS first, then USB. Check that
  the pedal and computer are on the same network, or open the connection sheet
  and pick the USB port. `/dev/ttyACM0` needs the udev rule in
  `packaging/linux/70-stompstation.rules` if access is denied.
- **Wi-Fi connects but commands time out.** Firmware 2.5.3 allows several
  simultaneous network readers, but writes are not coordinated between clients.
  On older firmware close other clients before reconnecting; USB serial still
  supports one client at a time.
- **Save is disabled.** It enables only when the preset is dirty. Chain edits,
  bypasses, model changes, and knob changes all mark it dirty; a board refresh
  does not clear it.
- **Parametric NAM looks empty.** A PNAM block needs an active `pmodel`. The app
  selects the first available model when switching type; changing the model
  rebrowses the editor so `p1..pN` labels and ranges appear.
- **Remove/replace is disabled.** Fixed slots (amp, delay, reverb on 2.4.4) are
  protected. Replacement also requires at least one unused block.
- **Simulator connection.** Start `cargo run -p stomp-sim -- --port 45678` and
  connect to `127.0.0.1:45678` in the Network tab, or use `--demo` for the
  in-process browser board.

## Protocol reference

The original Python client is the reference implementation for the
reverse-engineered protocol. Its source map, protocol summary, tests, and design
dossier are documented in [`Legacy/README.md`](../Legacy/README.md). Nothing in
the Tauri app requires Python at runtime.
