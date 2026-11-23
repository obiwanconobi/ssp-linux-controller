#!/usr/bin/env bash
# Build, install, and UI-test StompStation on an Android emulator/device.
#
#   ./scripts/android-e2e.sh appium     # Appium/WDIO smoke + lifecycle
#   ./scripts/android-e2e.sh cdp        # fast Playwright-over-CDP smoke
#   ./scripts/android-e2e.sh both       # CDP first, then Appium
#
# Options:
#   --headless        boot the emulator without a window
#   --skip-build      reuse dist/android/stompstation-x86_64-debug.apk
#   --no-sim          assume the simulator is already running on STOMP_SIM_PORT
#   --keep-emulator   leave an emulator started by this script running on exit
#   --shutdown        compatibility alias; this is the default
#
# Environment:
#   ANDROID_HOME / ANDROID_SDK_ROOT, JAVA_HOME, NDK_HOME
#   ANDROID_AVD       default Pixel_10_Pro
#   ANDROID_SERIAL    target a specific device
#   STOMP_SIM_PORT    default 45700
#   STOMPSTATION_APK  override the debug APK path
#   STOMPSTATION_CLEAR_DATA=0 to keep app data
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UI="$ROOT/apps/desktop/ui"
HARNESS="$UI/e2e/android"

MODE="${1:-appium}"
if [[ "$MODE" != "appium" && "$MODE" != "cdp" && "$MODE" != "both" ]]; then
  echo "Usage: $0 [appium|cdp|both] [--headless] [--skip-build] [--no-sim] [--keep-emulator] [--shutdown]" >&2
  exit 2
fi
shift || true

HEADLESS=0
SKIP_BUILD=0
START_SIM=1
SHUTDOWN=1
for argument in "$@"; do
  case "$argument" in
    --headless) HEADLESS=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --no-sim) START_SIM=0 ;;
    --keep-emulator) SHUTDOWN=0 ;;
    --shutdown) SHUTDOWN=1 ;;
    *) echo "Unknown option: $argument" >&2; exit 2 ;;
  esac
done

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
if [[ -z "${JAVA_HOME:-}" && -x /opt/android-studio/jbr/bin/java ]]; then
  export JAVA_HOME=/opt/android-studio/jbr
fi
if [[ -z "${NDK_HOME:-}" && -d "$SDK/ndk" ]]; then
  NDK_HOME="$(find "$SDK/ndk" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -1)"
fi
export ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK"
[[ -n "${NDK_HOME:-}" ]] && export NDK_HOME ANDROID_NDK_HOME="$NDK_HOME"
PATH="$PATH:$SDK/platform-tools:$SDK/emulator:$HOME/.cargo/bin:$HOME/.local/share/pnpm/bin"
export PATH

APP_ID="${STOMPSTATION_PACKAGE:-pro.stompstation.desktop}"
SIM_PORT="${STOMP_SIM_PORT:-45700}"
AVD="${ANDROID_AVD:-Pixel_10_Pro}"
APK="${STOMPSTATION_APK:-$ROOT/dist/android/stompstation-x86_64-debug.apk}"
LOG_DIR="${E2E_LOG_DIR:-$ROOT/dist/android/e2e/logs}"
mkdir -p "$LOG_DIR"

if ! command -v adb >/dev/null 2>&1; then
  echo "adb not found. Set ANDROID_HOME or add $SDK/platform-tools to PATH." >&2
  exit 1
fi
if command -v pnpm >/dev/null 2>&1; then
  PM=pnpm
elif command -v npm >/dev/null 2>&1; then
  PM=npm
else
  echo "pnpm/npm not found. Add $HOME/.local/share/pnpm/bin to PATH or install pnpm." >&2
  exit 1
fi

SIM_PID=""
STARTED_EMULATOR=0
cleanup() {
  trap - EXIT INT TERM
  if [[ -n "$SIM_PID" ]]; then
    kill "$SIM_PID" 2>/dev/null || true
    wait "$SIM_PID" 2>/dev/null || true
  fi
  adb reverse --remove "tcp:$SIM_PORT" >/dev/null 2>&1 || true
  # Do not leave a headless emulator spinning after the suite. Only stop a
  # device this script booted; a pre-existing device belongs to the caller.
  if [[ "$SHUTDOWN" == "1" && "$STARTED_EMULATOR" == "1" ]]; then
    adb emu kill >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

port_is_open() {
  (exec 3<>"/dev/tcp/127.0.0.1/$SIM_PORT") >/dev/null 2>&1
}

wait_for_port() {
  for _ in $(seq 1 80); do
    if port_is_open; then return 0; fi
    sleep 0.25
  done
  return 1
}

device_connected() {
  adb devices | awk 'NR>1 && $2=="device" {found=1} END {exit !found}'
}

boot_emulator() {
  if device_connected; then
    return 0
  fi
  if ! command -v emulator >/dev/null 2>&1; then
    echo "No device connected and emulator is not installed." >&2
    exit 1
  fi
  STARTED_EMULATOR=1
  local emulator_args=(-avd "$AVD" -no-snapshot -no-audio -no-boot-anim)
  if [[ "$HEADLESS" == "1" ]]; then
    emulator_args+=(-no-window -gpu swiftshader_indirect)
  fi
  echo "== booting emulator $AVD =="
  nohup emulator "${emulator_args[@]}" >"$LOG_DIR/emulator.log" 2>&1 &
  adb wait-for-device
  for _ in $(seq 1 240); do
    if [[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]]; then
      break
    fi
    sleep 1
  done
  if [[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != "1" ]]; then
    echo "Emulator did not finish booting. See $LOG_DIR/emulator.log" >&2
    exit 1
  fi
  adb shell input keyevent 82 >/dev/null 2>&1 || true
  adb shell settings put global window_animation_scale 0 >/dev/null 2>&1 || true
  adb shell settings put global transition_animation_scale 0 >/dev/null 2>&1 || true
  adb shell settings put global animator_duration_scale 0 >/dev/null 2>&1 || true
}

echo "== Android E2E ($MODE) =="
echo "   SDK:     $SDK"
echo "   app:     $APP_ID"
echo "   APK:     $APK"
echo "   sim:     127.0.0.1:$SIM_PORT"
echo "   logs:    $LOG_DIR"

boot_emulator
SERIAL="$(adb devices | awk 'NR>1 && $2=="device" {print $1; exit}')"
if [[ -z "$SERIAL" ]]; then
  echo "No authorized device/emulator." >&2
  exit 1
fi
export ANDROID_SERIAL="$SERIAL"

if [[ "$SKIP_BUILD" != "1" ]]; then
  echo "== building debug APK =="
  "$ROOT/scripts/build-android.sh" x86_64 debug
fi
if [[ ! -f "$APK" ]]; then
  echo "APK not found at $APK (build it or pass --skip-build only after a build)." >&2
  exit 1
fi

if [[ "$START_SIM" == "1" ]]; then
  if port_is_open; then
    echo "== simulator already listening on $SIM_PORT =="
  else
    echo "== starting simulator on $SIM_PORT =="
    (cd "$ROOT" && cargo build -p stomp-sim)
    "$ROOT/target/debug/stomp-sim" --port "$SIM_PORT" >"$LOG_DIR/stomp-sim.log" 2>&1 &
    SIM_PID=$!
    if ! wait_for_port; then
      echo "Simulator did not start. See $LOG_DIR/stomp-sim.log" >&2
      exit 1
    fi
  fi
fi

echo "== installing $APK =="
adb install -r "$APK"
if [[ "${STOMPSTATION_CLEAR_DATA:-1}" != "0" ]]; then
  adb shell pm clear "$APP_ID" >/dev/null 2>&1 || true
fi
adb reverse "tcp:$SIM_PORT" "tcp:$SIM_PORT"

run_appium() {
  if [[ ! -d "$HARNESS/node_modules" ]]; then
    echo "== installing Appium/WDIO harness dependencies =="
    (cd "$HARNESS" && "$PM" install)
  fi
  echo "== running Appium/WDIO suite =="
  (
    cd "$HARNESS"
    # The emulator is already running; don't ask Appium to boot a second one.
    unset ANDROID_AVD
    STOMPSTATION_APK="$APK" STOMP_SIM_PORT="$SIM_PORT" E2E_LOG_DIR="$LOG_DIR" \
      "$PM" test
  )
}

run_cdp() {
  echo "== running Playwright/CDP smoke =="
  (
    cd "$UI"
    STOMPSTATION_PACKAGE="$APP_ID" STOMP_SIM_PORT="$SIM_PORT" \
      E2E_ARTIFACT_DIR="$ROOT/dist/android/e2e" \
      node scripts/android-webview-smoke.mjs
  )
}

case "$MODE" in
  cdp) run_cdp ;;
  appium) run_appium ;;
  both)
    run_cdp
    # CDP may close the WebView when it disconnects; Appium will relaunch.
    run_appium
    ;;
esac

echo
echo "Android E2E ($MODE) passed."
echo "Artifacts: $ROOT/dist/android/e2e"
