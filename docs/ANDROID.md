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
| Target SDK | 36 (Android 16) — see local-network note below |
| Rust targets | `aarch64-linux-android`, `x86_64-linux-android` |
| Tested runtime | Pixel 10 Pro emulator, API 37, x86_64 |
| Tested transport | TCP through `adb reverse` to the bundled simulator |
| APK signing | Android debug key (sideload only) |
| Artifacts | `dist/android/stompstation-aarch64-release.apk`, `…-x86_64-release.apk` |

The arm64 APK was built successfully but has not been run on a physical phone.
The x86_64 release APK was installed and exercised in the emulator. Current
artifacts are `stompstation-aarch64-release.apk` (8.5 MB) and
`stompstation-x86_64-release.apk` (9.0 MB).

## What works on Android

- The full board, inspector, master strip, and responsive shell render over a
  TCP connection. Board, inspector, and master were exercised in the emulator;
  save, chain, EQ, amp room, library, and stage use the same Rust commands but
  were not individually re-tested on Android.
- Wi-Fi discovery uses the same mDNS `_http._tcp` browse as desktop.
- The generated `MainActivity` acquires an Android `MulticastLock` so mDNS
  replies are not filtered.
- Manual `host:port` connection is available when mDNS is blocked by the
  network.
- The mobile connection sheet defaults to **Wi-Fi / Network** and does not show
  the desktop USB controls.
- `adb reverse tcp:45700 tcp:45700` plus the simulator at
  `./target/debug/stomp-sim --port 45700` is the fastest emulator test path;
  connect the app to `127.0.0.1:45700`.

## What is not supported yet

- USB serial / USB OTG. A future Android USB-host implementation would need a
  USB serial driver, permission flow, and a serial-to-Transport adapter.
- Play Store publishing: the current release APK is signed with the local
  Android debug key. A real upload key and AAB are still needed.
- Physical-device validation on Wi-Fi, including multicast behavior on locked
  screens and vendor Wi-Fi stacks.
- A tablet/landscape-specific layout. The existing responsive CSS works, but
  the UI is still desktop-first and the chain scrolls horizontally on phones.
- Android background lifecycle: polling pauses when the WebView is destroyed,
  but reconnect-on-resume has not been hardened.

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

./scripts/build-android.sh aarch64 release   # phone
./scripts/build-android.sh x86_64 release   # emulator
./scripts/build-android.sh aarch64 debug    # large, debuggable
```

The script:

1. verifies/converts the Android project if `gen/android` is missing;
2. runs `cargo tauri android build --apk --target …`;
3. zipaligns and signs release APKs;
4. copies the result to `dist/android/`.

`dist/` is gitignored; the APK is a local build artifact.

### Release signing

By default the script signs with `~/.android/debug.keystore` (creating it if
needed). That is enough for `adb install` and local testing. For a real release,
set:

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

## Build internals

- Desktop builds enable `stomp-device/serial` and `stomp-transport/serial`.
  Android builds set `default-features = false` for those crates; the serial
  transport is replaced by a compile-only stub that returns
  `Unsupported` if invoked.
- `stomp-transport` keeps mDNS enabled on Android.
- `MainActivity.kt` acquires a `MulticastLock` before `super.onCreate` and
  releases it in `onDestroy`; the manifest declares
  `ACCESS_WIFI_STATE` and `CHANGE_WIFI_MULTICAST_STATE`.
- The generated Android project lives in
  `apps/desktop/src-tauri/gen/android`. Tauri’s generated Gradle files and
  `jniLibs` remain ignored; `MainActivity.kt`, the manifest, icons, and Gradle
  project files are source.
- `beforeBuildCommand` is `pnpm --dir ../ui build` because Tauri runs build
  commands from `src-tauri`.

## Android 17 local-network permission

Apps targeting SDK 37 must declare and request the runtime
`android.permission.ACCESS_LOCAL_NETWORK` before opening LAN TCP or mDNS
sockets. This build keeps `targetSdk = 36`, where `INTERNET` still grants LAN
access implicitly, so the sideload APK works without an extra prompt. Before
bumping to target 37, add the manifest permission and request it from
`MainActivity` (and retry discovery after the grant). Do not bump the target
without that change or Wi-Fi connections/mDNS will time out on Android 17.

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
