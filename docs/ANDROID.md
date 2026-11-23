# Android APK

The same React UI and Rust device core now build as an Android app. The mobile
build is **Wi-Fi/TCP only**; Android does not expose a usable USB CDC-ACM
serial port to this app, so the connection sheet hides USB and the serial
transport returns a clear “unsupported” error if an address is forced.

## Status

| Item | Value |
| --- | --- |
| Package | `pro.stompstation.desktop` |
| Min SDK | 24 |
| Compile SDK | 37 (Android 17) |
| Target SDK | 37 (Android 17) — runtime local-network permission requested |
| Rust targets | `aarch64-linux-android`, `x86_64-linux-android` |
| Tested runtime | Pixel 10 Pro emulator, API 37, x86_64 |
| Tested transport | TCP through `adb reverse` to the bundled simulator |
| UI tests | Playwright/CDP + Appium/UiAutomator2 debug-APK harness; CI emulator workflow |
| APK signing | Android debug key by default; upload-key env vars for Play releases |
| Artifacts | `dist/android/stompstation-<arch>-<mode>.apk`, `…-release.aab` |

The arm64 APK/AAB build successfully but have not been run on a physical phone.
The x86_64 debug APK is installed and exercised in the emulator by the full
Appium suite. Local artifacts include `stompstation-aarch64-release.aab` and
the debug/release APKs; `dist/` is ignored.

## What works on Android

- The full board, inspector, master strip, and responsive shell render over a
  TCP connection. Phones use a wrapped, knob-free chain overview; tapping a
  block opens the full-height block editor, and Android Back or the `‹ Chain`
  header returns to the overview. Amp room is desktop-only — amp controls
  remain available in the block editor. Tablets and landscape phones keep the
  chain + inspector layout. Board, inspector, and master were exercised in the
  emulator; save, chain, EQ, library, and stage use the same Rust commands but
  were not individually re-tested on Android.
- The shell honors Android safe-area insets, so the chrome clears the status
  and gesture bars. At phone widths the header collapses its labels and action
  set to a two-row layout, keeping the page free of horizontal scroll; Settings
  hides the desktop-only USB transport and works over Wi-Fi.
- Wi-Fi discovery uses the same mDNS `_http._tcp` browse as desktop.
- The generated `MainActivity` acquires an Android `MulticastLock` so mDNS
  replies are not filtered.
- Manual `host:port` connection is available when mDNS is blocked by the
  network.
- The mobile connection sheet defaults to **Wi-Fi / Network** and does not show
  the desktop USB controls. It is centered on phones rather than anchored to
  the bottom, with a fixed header/footer and a scrolling body.
- `adb reverse tcp:45700 tcp:45700` plus the simulator at
  `./target/debug/stomp-sim --port 45700` is the fastest emulator test path;
  connect the app to `127.0.0.1:45700`.
- Android's document picker returns `content://` URIs. `MainActivity` copies
  the selected file into app cache (`StompAndroid.resolveFileUri`) so the Rust
  preflight/upload path still sees a normal file. Save dialogs use the reverse
  bridge: Rust writes an app-cache file, then `copyFileToUri` writes it into the
  user-selected document.
- The emulator UI suite covers connect, the nine-block board (cards in
  portrait, pedal shells in landscape), the chain → editor → chain flow with
  Android Back, a typed knob edit + save, rotation, background/resume, a real
  document-picker upload, and a content-URI download save. See
  [`ANDROID_UI_TESTING.md`](ANDROID_UI_TESTING.md).

## What is not supported yet

- USB serial / USB OTG. A future Android USB-host implementation would need a
  USB serial driver, permission flow, and a serial-to-Transport adapter.
- The desktop Local-files folder scan. Android SAF tree URIs are not filesystem
  paths, so the Library tab hides Local files on mobile; single-file capture
  upload/download works through the content-URI bridge.
- Play Store publishing: the AAB build/signing path works, but the current
  local AAB uses the debug key. A real upload key and Play Console setup are
  still needed.
- Physical-device validation on Wi-Fi, including multicast behavior on locked
  screens and vendor Wi-Fi stacks.
- A separate Android visual-regression baseline set. The browser baselines
  cover layout/theme; the Android suite keeps screenshots as test artifacts and
  asserts usable geometry instead of maintaining per-API images.
- Physical-phone UI automation. The emulator suite is automated; the phone
  matrix still needs a manual run.

## Prerequisites

- JDK 17+ (Android Studio’s bundled JBR works; this machine used
  `/opt/android-studio/jbr`, Java 25).
- Android SDK with platform 37, build-tools 36+, platform-tools, and NDK
  28.2.13676358 (or another NDK supported by Tauri).
- Rust Android targets:
  ```bash
  rustup target add aarch64-linux-android x86_64-linux-android
  ```
- Tauri CLI:
  ```bash
  cargo install tauri-cli --version '^2' --locked
  ```
- `pnpm` and the UI dependencies (`pnpm install` in `apps/desktop/ui`).

The environment is auto-detected from `/opt/android-studio/jbr` and
`~/Android/Sdk` by the build script. Override with `JAVA_HOME`,
`ANDROID_HOME`/`ANDROID_SDK_ROOT`, and `NDK_HOME` as needed.

## Build

```bash
export JAVA_HOME=/opt/android-studio/jbr
export ANDROID_HOME="$HOME/Android/Sdk"
export NDK_HOME="$ANDROID_HOME/ndk/28.2.13676358"

./scripts/build-android.sh aarch64 release       # phone
./scripts/build-android.sh x86_64 release       # emulator
./scripts/build-android.sh aarch64 debug        # large, debuggable
./scripts/build-android.sh aarch64 release aab  # Play Store AAB
```

The script:

1. verifies/converts the Android project if `gen/android` is missing;
2. runs `cargo tauri android build --apk` or `--aab` for the requested target;
3. zipaligns/signs release APKs, or jarsigns the AAB;
4. copies the result to `dist/android/`.

`dist/` is gitignored; the APK is a local build artifact.

### Release signing

By default the script signs APKs with `~/.android/debug.keystore` (creating it
if needed) and signs AABs with `jarsigner`. That is enough for `adb install` and
local testing. For a real release, set:

```bash
export STOMPSTATION_KEYSTORE=/path/to/upload.keystore
export STOMPSTATION_KEY_ALIAS=upload
export STOMPSTATION_KEYSTORE_PASSWORD=…
export STOMPSTATION_KEY_PASSWORD=…
./scripts/build-android.sh aarch64 release
```

Do not commit the keystore or passwords. The generated Gradle project also
ignores `key.properties` / `keystore.properties`.

## Install

```bash
adb install -r dist/android/stompstation-aarch64-release.apk
```

On a phone, put the phone and pedal on the same Wi-Fi network. The app opens
the connection sheet after its mDNS scan; select the discovered device or enter
`<pedal-ip>:8080`. The pedal’s normal TCP service uses port `8080`.

For the emulator and simulator:

```bash
# terminal 1
./target/debug/stomp-sim --port 45700

# terminal 2
adb reverse tcp:45700 tcp:45700
adb install -r dist/android/stompstation-x86_64-release.apk
```

In the app use `127.0.0.1:45700`. `adb reverse` is needed because the emulator
does not route to the host LAN. The app’s mDNS scan may return nothing in the
emulator; manual address entry is expected there.

## UI tests

See [`ANDROID_UI_TESTING.md`](ANDROID_UI_TESTING.md) for the full harness
architecture, test inventory, selectors, extension recipes, known automation
quirks, and remaining UI-test work.

The Android UI suite runs against the real system WebView and native shell. It
needs a **debug** APK: Wry enables WebView debugging only when
`debug_assertions` is on, which is what exposes the `WEBVIEW_*` context to
Appium.

```bash
# Fast Playwright-over-CDP DOM smoke
./scripts/android-e2e.sh cdp

# Full Appium + UiAutomator2 + WebdriverIO suite
./scripts/android-e2e.sh appium

# Both
./scripts/android-e2e.sh both

# Stop leftover local test emulators and the simulator
./scripts/android-stop.sh
```

The script builds `stompstation-x86_64-debug.apk` unless `--skip-build` is
passed, boots `Pixel_10_Pro` if no device is connected, starts the simulator on
`45700`, runs `adb reverse`, clears app data, and installs the APK. It stops an
emulator it started when it exits; use `--keep-emulator` to leave it running.
Artifacts go to `dist/android/e2e/`.

Harness: `apps/desktop/ui/e2e/android/`. It switches from `NATIVE_APP` to
`WEBVIEW_pro.stompstation.desktop`, uses the simulator over `adb reverse`, and
covers:

- connect to `127.0.0.1:45700` and render nine board blocks
- open the phone block editor, change the Noise Gate threshold through the real
  Tauri IPC path, and save
- close the connection sheet, and leave the block editor, with Android Back
  without exiting

The suite uses Appium 4 + UiAutomator2 + WebdriverIO 10. The first run may take
a minute while Appium installs its helper APK and downloads a chromedriver
matching the system WebView. `pnpm` is used because this machine does not install
`npm`; Appium resolves the SDK/JDK from the usual locations.

Android Back handling: `MainActivity` intercepts the hardware Back button and
calls `window.__stompHandleBack()` before finishing the activity. The web UI
closes the topmost overlay (tuner, command palette, connection sheet, patches
drawer, activity log, shortcuts), then returns from the phone block editor to
the chain, then to the board, then allows the activity to finish. The
connection sheet's header/footer are fixed and its body scrolls so
Connect/Disconnect stay reachable on phones.

Notes:

- The WebView is debuggable only in debug builds. Do not ship one.
- `appium:chromedriverAutodownload` is enabled; if the network blocks it, set
  `appium:chromedriverExecutable` in `apps/desktop/ui/e2e/android/wdio.conf.mjs`.
- CDP mouse clicks can be offset by the Android visual viewport; the CDP smoke
  uses DOM clicks for functional assertions. The Appium suite uses DOM clicks
  for buttons and native key events for Back.
- CDP typing into the React-controlled knob editor is unreliable in the Android
  WebView; the smoke drives the slider with keyboard `End`/`Home`. Use Appium
  `setValue`/`sendKeys` for a dedicated typed-input test.

## Build internals

- Desktop builds enable `stomp-device/serial` and `stomp-transport/serial`.
  Android builds set `default-features = false` for those crates; the serial
  transport is replaced by a compile-only stub that returns
  `Unsupported` if invoked.
- `stomp-transport` keeps mDNS enabled on Android.
- `MainActivity.kt` acquires a `MulticastLock` before `super.onCreate` and
  releases it in `onDestroy`; the manifest declares
  `ACCESS_WIFI_STATE`, `CHANGE_WIFI_MULTICAST_STATE`, and
  `ACCESS_LOCAL_NETWORK`. It owns the hardware Back callback, the
  `__stompOnResume` lifecycle hook, the local-network permission bridge, and the
  `StompAndroid` content-URI/cache bridge. See
  [`ANDROID_UI_TESTING.md`](ANDROID_UI_TESTING.md).
- The generated Android project lives in
  `apps/desktop/src-tauri/gen/android`. Tauri’s generated Gradle files and
  `jniLibs` remain ignored; `MainActivity.kt`, the manifest, icons, and Gradle
  project files are source.
- `beforeBuildCommand` is `pnpm --dir ../ui build` because Tauri runs build
  commands from `src-tauri`.

## Android 17 local-network permission

The build targets SDK 37 and declares
`android.permission.ACCESS_LOCAL_NETWORK`. `MainActivity` requests the runtime
permission on launch (API 37+) and calls
`window.__stompLocalNetworkPermission(granted)` once the WebView handler is
ready. The React shell retries automatic discovery on a grant and shows a
warning on denial. On API 36 and older the permission is not requested and
`INTERNET` continues to grant LAN access.

## Troubleshooting

- **mDNS finds nothing.** Vendor Wi-Fi stacks sometimes block multicast even
  with a MulticastLock. Enter the pedal’s IP manually. Confirm the phone and
  pedal are on the same subnet and that the pedal is awake.
- **Connection times out.** Only one client should own the pedal. Close the
  desktop app/Python UI and retry. On the emulator, use `adb reverse` and
  `127.0.0.1`.
- **APK installs but shows no device.** Android has no USB serial path in this
  build; use Wi-Fi or manual TCP.
- **Build cannot find the SDK/NDK.** Export `ANDROID_HOME`, `NDK_HOME`, and
  `JAVA_HOME` before running the script. The Tauri CLI prints the NDK it uses.
- **Gradle warnings about Java source/target 8.** These come from Tauri/AGP
  templates and are warnings; the build still succeeds with JDK 25.
