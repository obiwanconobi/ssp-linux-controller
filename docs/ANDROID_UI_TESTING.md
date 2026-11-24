# Android UI testing

This is the working reference for the Android WebView/native UI test harness.
It records what exists, why it is shaped this way, how to run and extend it, and
what is still unverified.

- Harness: [`apps/desktop/ui/e2e/android/`](../apps/desktop/ui/e2e/android/)
- Orchestrator: [`scripts/android-e2e.sh`](../scripts/android-e2e.sh)
- Fast CDP smoke:
  [`apps/desktop/ui/scripts/android-webview-smoke.mjs`](../apps/desktop/ui/scripts/android-webview-smoke.mjs)
- Build/install/signing reference: [`ANDROID.md`](ANDROID.md)

## Status

| Item | Value |
| --- | --- |
| Last validated | 2026-11-23 |
| Runtime | Pixel 10 Pro AVD, API 37, x86_64 |
| App | `pro.stompstation.desktop` · `.MainActivity` |
| APK | debug x86_64 (`dist/android/stompstation-x86_64-debug.apk`) |
| Transport | simulator over `adb reverse` |
| Appium | 4.0.0 |
| UiAutomator2 driver | 9.3.0 |
| WebdriverIO | 10.2.0 |
| Node / pnpm | 22.23.5 / 12.21.0 |
| JDK / SDK / NDK | Android Studio JBR (25) / platform 37 / 28.2.13676358 |

Validated:

- `./scripts/android-e2e.sh both` — CDP smoke plus the full Appium suite.
- Appium specs: smoke, lifecycle/Back (sheet and block editor), typed knob,
  rotation/landscape, background/resume, native DocumentsUI file-picker upload,
  and a native save-picker download through a content-URI destination.
- Existing browser checks: `pnpm test`, `test:ui`, `test:mobile`,
  `test:startup`, `test:a11y`, `test:states`, `test:visual` all pass.
- `appium driver doctor uiautomator2` reports 0 required fixes; `bundletool.jar`
  is the only optional warning.
- CI emulator workflow: `.github/workflows/android-ui.yml` (API 37.1 16 KB-page
  Google APIs system image on a Pixel 7 profile; the action's platform-install
  input remains 36 because API 37 is published as the versioned
  `platforms;android-37.0`. Physical API 37 permission prompt remains manual).

Not validated:

- A physical phone (Wi-Fi/mDNS and manual address).
- A separate Android visual-regression baseline set. Decided against: browser
  visual baselines cover layout/theme, and Android keeps screenshots as
  artifacts plus geometry assertions.
- Android 17 permission prompt on a physical/API 37 device with the dialog
  actually shown and denied/allowed interactively.

## Why two paths

Tauri does **not** use `tauri-driver` or `@wdio/tauri-service` on Android. Those
are desktop-webview tools. On Android:

| Path | Tool | Best for |
| --- | --- | --- |
| Fast DOM | Playwright over Chrome DevTools Protocol | selectors, DOM assertions, screenshots, quick debugging |
| Full app | Appium 4 + UiAutomator2 + WebdriverIO | install/launch, native shell, lifecycle, CI, real touch/key events |

The harness uses both. The CDP smoke is the fast inner loop; Appium is the
authoritative suite. Tauri's own mobile E2E suite is the reference for the
Appium pattern:
<https://github.com/tauri-apps/plugins-workspace/tree/v2/packages/api-e2e>

## Alternatives considered

- `tauri-driver` / `@wdio/tauri-service`: desktop WebView only. Not usable for
  Android.
- `tauri-plugin-webdriver`: a third-party in-app W3C WebDriver server. Not
  adopted; it is new, adds an automation HTTP surface to the app, and would
  need its own maintenance. Appium is the safer baseline.
- Maestro / Maestro MCP: excellent for native-shell exploration, but its
  Android WebView hierarchy path (`androidWebViewHierarchy: devtools`) is
  unreliable and has an open issue on recent WebView versions. Not suitable as
  the DOM assertion layer for a Tauri app.
- Generic Android native-testing skills (Compose/Espresso): wrong layer for a
  React-in-WebView UI.

Sources used for the harness pattern:

- Tauri mobile E2E suite:
  <https://github.com/tauri-apps/plugins-workspace/tree/v2/packages/api-e2e>
- Appium agent skills:
  <https://github.com/appium/skills>
- Appium UiAutomator2 driver:
  <https://appium.github.io/appium-uiautomator2-driver/>
- WebdriverIO mobile docs:
  <https://webdriver.io/docs/platforms/mobile>

## Required build shape

The APK must be a **debug** build. Wry enables
`WebView.setWebContentsDebuggingEnabled(true)` only for `debug_assertions` (or
with the `devtools` feature). Without that, there is no `WEBVIEW_*` context and
no CDP socket.

Do not ship a debug APK or a test WebDriver surface.

## Quick start

From the repository root:

```bash
# Fast Playwright-over-CDP DOM smoke
./scripts/android-e2e.sh cdp

# Full Appium/UiAutomator2/WebdriverIO suite
./scripts/android-e2e.sh appium

# Both
./scripts/android-e2e.sh both
```

Options:

```text
--headless       boot the emulator without a window
--skip-build     reuse dist/android/stompstation-x86_64-debug.apk
--no-sim         assume the simulator already listens on STOMP_SIM_PORT
--keep-emulator  leave an emulator started by this script running on exit
--shutdown       compatibility alias; stopping the script-owned emulator is the default
```

The script stops an emulator it booted when it exits. Use `--keep-emulator` for
rapid iteration, and stop any leftover test emulator or host simulator with:

```bash
./scripts/android-stop.sh
```

Environment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANDROID_AVD` | `Pixel_10_Pro` | AVD to boot |
| `ANDROID_SERIAL` | first device | target device |
| `STOMPSTATION_PACKAGE` | `pro.stompstation.desktop` | application ID |
| `STOMP_SIM_PORT` | `45700` | host simulator port |
| `STOMPSTATION_APK` | `dist/android/...debug.apk` | APK override |
| `STOMPSTATION_CLEAR_DATA` | `1` | set `0` to preserve app data |
| `E2E_LOG_DIR` | `dist/android/e2e/logs` | Appium/screenshot logs |
| `E2E_DIAGNOSTICS_DIR` | `dist/android/e2e/diagnostics` | failure evidence |
| `E2E_ARTIFACT_DIR` | `dist/android/e2e` | CDP artifacts |

The script resolves `JAVA_HOME` from `/opt/android-studio/jbr` and
`ANDROID_HOME` from `~/Android/Sdk` when they are unset. It uses `pnpm` when
available, otherwise `npm`. `adb` is taken from the SDK; it does not need to be
on the caller's `PATH`.

## Direct commands

```bash
# Full suite from the harness
pnpm --dir apps/desktop/ui/e2e/android test
pnpm --dir apps/desktop/ui/e2e/android test:smoke
pnpm --dir apps/desktop/ui/e2e/android test:lifecycle
pnpm --dir apps/desktop/ui/e2e/android test:typed
pnpm --dir apps/desktop/ui/e2e/android test:rotation
pnpm --dir apps/desktop/ui/e2e/android test:resume
pnpm --dir apps/desktop/ui/e2e/android test:file-picker
pnpm --dir apps/desktop/ui/e2e/android test:save-picker

# Fast CDP smoke (from the UI package so `playwright` resolves)
(cd apps/desktop/ui && node scripts/android-webview-smoke.mjs)
```

The harness installs its own Appium/WDIO dependencies on first run and uses
`appium:chromedriverAutodownload`. The first session may take a minute while
Appium installs its helper APK and downloads a chromedriver matching the system
WebView.

## What the suite covers

`specs/smoke.spec.mjs`:

1. Clears/opens the connection sheet.
2. Connects to `127.0.0.1:45700`.
3. Asserts nine board blocks, the phone chain overview, and that the Amp room
   tab is absent.
4. Opens the first block card in the full-height mobile editor.
5. Moves Threshold to the opposite end via `End`/`Home`.
6. Asserts the readout and `aria-valuenow` update through the real Tauri IPC
   path.
7. Asserts the preset is **Edited**, saves, and asserts **Saved**.
8. Captures `dist/android/e2e/logs/appium-smoke.png`.

`specs/lifecycle.spec.mjs`: (a) opens the connection sheet, switches to
`NATIVE_APP`, sends Android Back, switches back to
`WEBVIEW_pro.stompstation.desktop`, and asserts the sheet closed while the app
stayed alive. (b) connects, opens the phone block editor, sends native Back,
and asserts the chain pane and nine cards return.

`specs/typed-knob.spec.mjs`: opens the first block (card or pedal depending on
layout), opens the knob readout editor, sends real key events through Appium,
commits `-34`, and asserts the readout, `aria-valuenow`, `aria-valuetext`, and
the Edited state.

`specs/rotation.spec.mjs`: asserts the portrait chain cards and no Amp tab,
rotates to landscape, asserts the board/inspector/master controls and nine
pedal shells remain present, checks no page-level horizontal overflow, scrolls
the short landscape board to the inspector, captures
`appium-landscape.png`, then restores portrait and asserts the chain cards
return.

`specs/background-resume.spec.mjs`: backgrounds the app with
`browser.background(3)`, waits for the WebView to reattach, and asserts the
simulator session is connected and synced after resume.

`specs/file-picker.spec.mjs`: pushes a small WAV into `/sdcard/Download`, opens
the native DocumentsUI picker, selects it through the roots/Downloads flow,
switches back to the WebView, asserts the IR preflight, then completes the
upload through the real ACK path. This exercises the `content://` →
`StompAndroid.resolveFileUri` cache bridge.

`specs/save-picker.spec.mjs`: downloads an IR from the simulator, renames the
document in the native save picker, saves it, and verifies the 8248-byte WAV in
`/sdcard/Download`. This exercises `StompAndroid.cachePathForName` +
`copyFileToUri`.

The CDP smoke covers the same connect/edit/save flow with DOM assertions, plus
its own screenshot and failure capture.

## Harness internals

### Context switching

The session starts in `NATIVE_APP`. The suite waits for the exact
`WEBVIEW_pro.stompstation.desktop` context, retrying the switch because Android
lists the context before the page is attachable:

```js
contexts.find((name) => name === `WEBVIEW_${appId}`)
```

Other apps can expose debuggable WebViews, hence the exact package match.

### Readiness

`window.__TAURI__` is absent because the app imports `@tauri-apps/api`; the
suite waits for `window.__TAURI_INTERNALS__`. It also sets the driver script
timeout to 30s because the UiAutomator2 driver may default to 0.

### App data

`onPrepare` runs `adb shell pm clear` when a device is already connected. The
specs also tolerate a remembered connection from a previous run: they open the
connection sheet, disconnect if needed, and reconnect.

Appium uses `appium:enforceAppInstall` because every local build has the same
version code; otherwise the old APK can stay installed.

### chromedriver

The device's system WebView updates independently of the app. The harness uses
`appium:chromedriverAutodownload` and
`--allow-insecure=uiautomator2:chromedriver_autodownload`. If the network blocks
the download, set `appium:chromedriverExecutable` in `wdio.conf.mjs`.

### `adb reverse`

The emulator's `127.0.0.1` is not the host's. The suite re-runs
`adb reverse tcp:45700 tcp:45700` in the `before` hook for every session,
because Appium may boot or recreate the device.

### Clicking and typing quirks

Two Android-specific automation limits shaped the tests:

- **Click coordinates:** chromedriver's `elementClick` can report a visible
  button as "not interactable" because the Android visual viewport inset shifts
  CDP coordinates. The suite uses a DOM `click()` helper (`jsClick`) for
  functional button presses. Use a native-context tap when the test is
  specifically about touch hit-testing.
- **Controlled text inputs:** CDP typing into the knob's controlled editor
  changes the DOM value but does not reliably raise React's `onChange` in the
  Android WebView. The smoke uses the slider's keyboard contract
  (`End`/`Home`/arrows). Add a typed-value test with Appium `setValue` if that
  path needs coverage.

`strictSelectors: false` is intentional: `.signal-chain .pedal` / `.mobile-block-card`
can match multiple board blocks and `$` should resolve the first one. Specs use
the `BOARD_BLOCK` helper (`.mobile-block-card, .signal-chain .pedal`) and
`openFirstBlockEditor()` so the same test runs in portrait and landscape.

### Failure evidence

`afterTest` writes to `dist/android/e2e/diagnostics/<timestamp-label>/`:

- `screen.png`
- `window.txt`
- `activities.txt`
- `logcat.txt`
- `forwards.txt` / `reverses.txt`
- `webview-sockets.txt`

The CDP smoke writes `webview-smoke-failure.png`, `.html`, and logcat next to
`dist/android/e2e/`.

## App-side hooks to preserve

### Android Back

`MainActivity` sets `handleBackNavigation = false` and installs its own
`OnBackPressedCallback`. It calls:

```js
(window.__stompHandleBack && window.__stompHandleBack()) === true
```

The React handler in `App.tsx` closes the topmost overlay in this order:
tuner, command palette, connection sheet, patches drawer, activity log,
shortcuts; then returns from the phone block editor to the chain, then to the
board. If nothing is open it returns `false`, and the activity finishes.

This replaced Wry's default WebView-history callback. The app uses
`history.replaceState` for view changes, so history is not the right back
semantics here. Preserve this hook if the overlay state model changes.

### Connection sheet footer

`.connection-sheet` is a flex column with a fixed header/footer and a scrollable
body. On phones it is centered rather than a bottom sheet, and its height is
capped to the dynamic viewport minus safe-area insets. This keeps
Connect/Disconnect reachable; previously the footer could sit below the
viewport. The CSS lives in `apps/desktop/ui/src/styles/base.css`
(centering/safe-area) and `app.css` (sheet body/footer).

### Vitest isolation

`apps/desktop/ui/vite.config.ts` excludes `e2e/android/**` so Vitest does not
try to run the WebdriverIO specs. Keep that exclusion if the harness moves.

## Selectors

| UI | Selector |
| --- | --- |
| Connection status / open sheet | `.connection-pill` |
| Connection sheet | `.connection-sheet` |
| Manual address | `#manual-address` |
| Connect | `.connection-sheet__actions .btn--primary` |
| Disconnect | `.connection-sheet .btn--danger` |
| Board blocks (card or pedal) | `.mobile-block-card, .signal-chain .pedal` |
| Phone chain overview | `.mobile-chain` |
| Phone block card | `.mobile-block-card` |
| Full-height phone editor | `.inspector--mobile` |
| Editor back to chain | `.inspector__back-btn` |
| Pedal cards (landscape/tablet) | `.signal-chain .pedal` |
| Inspector | `.inspector` |
| Knob dial | `.inspector .knob__dial[aria-label^="Threshold"]` |
| Knob readout | `.inspector .knob__readout[title^="Threshold:"]` |
| Save | `.title-bar__save` |
| Save state | `.status-bar__save` (the title-bar chip is hidden on phones) |
| Board tab | `#nav-tab-board` |
| Library tab | `#nav-tab-library` |

Prefer `aria-label`, role, label text, and stable class names over nth-child
paths. Add `data-testid` only when no semantic selector exists.

## Extending the suite

To add a spec:

1. Add `specs/<name>.spec.mjs`; the WDIO glob picks up `specs/**/*.spec.mjs`.
2. Use `jsClick(browser, selector)` for functional button presses.
3. Use the real simulator; do not mock `invoke` on Android.
4. Reset app data if the test depends on first-launch state.
5. Capture a screenshot on success only when the artifact is useful; failures
   already capture evidence.

Native-shell recipes:

- **Rotation:** `browser.setOrientation('LANDSCAPE')`; assert the board,
  inspector, and master strip remain usable (portrait uses
  `.mobile-block-card`, landscape uses `.signal-chain .pedal`); restore
  portrait; screenshot.
- **Background/resume:** `browser.runAppInBackground(2)` or `adb shell input
  keyevent 3`; return to the app; wait for the WebView context again because it
  may be recreated; assert reconnect or a clear offline state.
- **File picker:** trigger upload in the WebView, switch to `NATIVE_APP`,
  interact with DocumentsUI, switch back, assert the result. Keep one small
  fixture.
- **Native touch:** use a native-context tap by coordinates or UiAutomator when
  hit-testing itself is the behavior under test.

The browser suite remains the fast layer for layout, a11y, keyboard, states, and
visual baselines. Do not duplicate it on Android unless the device WebView or
native shell changes the behavior.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No `WEBVIEW_*` context | Debug APK? page loaded? app process alive? `adb shell cat /proc/net/unix \| grep webview_devtools_remote`; `chrome://inspect` |
| Context listed but switch fails | Retry the switch; socket exists before the page is attachable |
| `element did not become interactable` | Use `jsClick`/DOM click or a native tap; visual viewport inset shifts coordinates |
| chromedriver mismatch | Autodownload enabled? network? pin `chromedriverExecutable` |
| App cannot reach simulator | `adb reverse --list`; re-run `adb reverse tcp:45700 tcp:45700` |
| Stale connection/theme | `adb shell pm clear pro.stompstation.desktop` |
| ANR dialog holds focus | Dismiss `android:id/aerr_close`; the harness already tries |
| First session slow | Appium helper APK install + chromedriver download; allow 120s |
| `pnpm install` fails on build scripts | `apps/desktop/ui/e2e/android/pnpm-workspace.yaml` explicitly ignores edgedriver/geckodriver builds |
| No `npm` on the machine | Use pnpm: `pnpm --dir apps/desktop/ui/e2e/android test` |

## Environment skills

Two user-level OpenCode skills mirror this workflow:

- `~/.config/opencode/skills/tauri-android-ui-testing/`
- `~/.config/opencode/skills/tauri-android-dev/`

They are environment-local, not repository files. This document and the harness
are the source of truth if the skills are missing or out of date. The UI testing
skill includes `check-env.sh`, `boot-emulator.sh`, `diagnostics.sh`, and
`attach-webview.mjs` helpers; the same operations are available through
`scripts/android-e2e.sh` and the harness here. To share the skills across
machines, copy those directories or add project-local `.opencode/skills/`
copies; do not let them drift from this document.

## Remaining Android UI work

- Run the suite against a physical phone over Wi-Fi (mDNS and manual address).
- Manually exercise the Android 17 `ACCESS_LOCAL_NETWORK` dialog on an API 37
  device: allow, deny, and retry discovery. Appium auto-grants runtime
  permissions, so this is not covered by the automated suite.
- Re-check `MainActivity` back handling if Tauri/Wry changes its activity
  template or `handleBackNavigation` contract.
- Exercise the phone chain → editor flow with touch scrolling, Android Back,
  and the centered connection sheet on a physical device.
- Keep the CI emulator workflow (`.github/workflows/android-ui.yml`) in sync
  with any new Appium specs.

## Related

- [`DEVELOPMENT.md`](DEVELOPMENT.md) — architecture, build, test commands, and
  release pipeline.
- [`ANDROID.md`](ANDROID.md) — build, install, signing, local-network notes.
- [`apps/desktop/ui/e2e/android/README.md`](../apps/desktop/ui/e2e/android/README.md)
  — harness-specific usage.
- [`DEVICE_SAFETY.md`](DEVICE_SAFETY.md) — read before hardware writes.
