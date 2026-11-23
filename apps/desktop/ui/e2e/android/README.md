# StompStation Android E2E

Full architecture, extension recipes, and remaining work:
[`docs/ANDROID_UI_TESTING.md`](../../../../../docs/ANDROID_UI_TESTING.md).

Appium 4 + UiAutomator2 + WebdriverIO tests against the real Tauri Android
WebView. The suite builds on Tauri's own mobile E2E pattern:

- debug APK (WebView debugging is enabled by Wry's `debug_assertions`)
- Appium session starts in `NATIVE_APP`
- the suite switches to `WEBVIEW_pro.stompstation.desktop`
- chromedriver is downloaded to match the device's system WebView
- `adb reverse` exposes the host simulator to the emulator

## Prerequisites

- Android SDK + NDK + JDK 17+
- `adb` on `PATH` or `ANDROID_HOME` set
- An emulator or device; the local AVD is `Pixel_10_Pro`
- Node 22+, pnpm or npm
- A debug APK at `dist/android/stompstation-x86_64-debug.apk`

From the repository root:

```bash
export JAVA_HOME=/opt/android-studio/jbr
export ANDROID_HOME="$HOME/Android/Sdk"
export PATH="$ANDROID_HOME/platform-tools:$PATH"

./scripts/build-android.sh x86_64 debug
```

Start the deterministic simulator on the host:

```bash
cargo build -p stomp-sim
./target/debug/stomp-sim --port 45700
```

Then expose it to the emulator:

```bash
adb reverse tcp:45700 tcp:45700
```

## Run

From the repo root:

```bash
./scripts/android-e2e.sh appium
```

Or directly from this directory:

```bash
pnpm install
pnpm test
pnpm test:smoke
pnpm test:lifecycle
```

The first run may take a few minutes while Appium installs the UiAutomator2
server and downloads a chromedriver matching the emulator's WebView.

## Environment

| Variable | Purpose |
|---|---|
| `STOMPSTATION_APK` | Override the debug APK path |
| `ANDROID_SERIAL` | Select a specific device/emulator |
| `ANDROID_AVD` | Let Appium boot this AVD instead of using a running device |
| `STOMP_SIM_PORT` | Simulator port (default `45700`) |
| `STOMPSTATION_PACKAGE` | Application ID (default `pro.stompstation.desktop`) |
| `STOMPSTATION_CLEAR_DATA` | Set to `0` to keep app data before the session |
| `E2E_LOG_DIR` | Screenshot/Appium log directory (default `dist/android/e2e/logs`) |
| `E2E_DIAGNOSTICS_DIR` | Failure diagnostics directory |

## Tests

- `smoke.spec.mjs` — connect to `127.0.0.1:45700`, assert nine board blocks,
  open the phone block editor, move a knob through the real Tauri IPC path,
  save, and screenshot.
- `lifecycle.spec.mjs` — close the connection sheet with native Android Back,
  then open the block editor and use Back to return to the chain without
  killing the app.
- `typed-knob.spec.mjs`, `rotation.spec.mjs`, `background-resume.spec.mjs`,
  `file-picker.spec.mjs`, and `save-picker.spec.mjs` cover real text entry,
  portrait/landscape layout, reconnect-on-resume, and the native content-URI
  bridges.

## Notes

- `strictSelectors: false` is intentional: `.signal-chain .pedal` /
  `.mobile-block-card` can match nine board blocks and `$` should resolve the
  first one. Use `BOARD_BLOCK` and `openFirstBlockEditor()` from
  `helpers/android.mjs` to stay layout-agnostic.
- Chromedriver's `elementClick` can fail hit-testing on Android because the
  visual viewport inset shifts coordinates. The suite uses a DOM click helper
  for functional button presses and native key events for Back. Use a
  native-context tap if the test is about touch hit-testing.
- CDP typing into the controlled knob editor changes the DOM value but does not
  reliably raise React's `onChange` in the Android WebView. The smoke drives the
  slider with `End`/`Home`. Add a typed-value test with Appium `setValue` if
  needed.
- Android Back is handled by `MainActivity` via `window.__stompHandleBack()`;
  the web UI closes the topmost overlay before the activity finishes.

## Troubleshooting

- **No `WEBVIEW_*` context**: the APK is not a debug build, the page has not
  loaded, or the app crashed. Check `adb logcat` and `chrome://inspect`.
- **chromedriver mismatch**: the harness asks Appium to autodownload. In a
  restricted network, set `appium:chromedriverExecutable` in `wdio.conf.mjs`.
- **App cannot reach the simulator**: `adb reverse --list`; re-run
  `adb reverse tcp:45700 tcp:45700`.
- **Stale connection state**: `adb shell pm clear pro.stompstation.desktop`.
- **ANR dialog holding focus**: the suite dismisses `android:id/aerr_close`
  before switching to the WebView.
- **Failure artifacts**: screenshots, window dumps, and logcat land in
  `dist/android/e2e/diagnostics/`.
