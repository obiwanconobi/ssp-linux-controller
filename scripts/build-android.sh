#!/usr/bin/env bash
# Build a sideloadable StompStation Android APK.
#
#   ./scripts/build-android.sh                 # arm64 release APK, debug-key signed
#   ./scripts/build-android.sh x86_64          # emulator release APK
#   ./scripts/build-android.sh aarch64 debug   # debug APK (not minified)
#   ./scripts/build-android.sh aarch64 release aab  # Play Store AAB
#
# Requires JDK 17+, Android SDK + NDK, rustup Android targets, cargo-tauri and
# pnpm. Set JAVA_HOME/ANDROID_HOME/NDK_HOME if they are not auto-detected.
#
# Release output is signed with the Android debug key by default so it can be
# installed locally, not published. For a real release, set:
#   STOMPSTATION_KEYSTORE, STOMPSTATION_KEY_ALIAS,
#   STOMPSTATION_KEYSTORE_PASSWORD, STOMPSTATION_KEY_PASSWORD
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP="$ROOT/apps/desktop"
TARGET="${1:-aarch64}"
MODE="${2:-release}"
FORMAT="${3:-apk}"

if [[ "$MODE" != "debug" && "$MODE" != "release" ]]; then
  echo "Mode must be 'debug' or 'release' (got '$MODE')." >&2
  exit 2
fi
if [[ "$FORMAT" != "apk" && "$FORMAT" != "aab" ]]; then
  echo "Format must be 'apk' or 'aab' (got '$FORMAT')." >&2
  exit 2
fi
if [[ "$FORMAT" == "aab" && "$MODE" == "debug" ]]; then
  echo "Use 'release' for an AAB; debug AABs are not publishable." >&2
  exit 2
fi

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
if [[ -z "${JAVA_HOME:-}" && -x /opt/android-studio/jbr/bin/java ]]; then
  export JAVA_HOME=/opt/android-studio/jbr
fi
if [[ -z "${JAVA_HOME:-}" ]]; then
  echo "JAVA_HOME is not set and /opt/android-studio/jbr was not found." >&2
  exit 1
fi
if [[ -z "${NDK_HOME:-}" ]]; then
  NDK_HOME="$(find "$SDK/ndk" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -1)"
fi
if [[ ! -d "$SDK" || -z "$NDK_HOME" || ! -d "$NDK_HOME" ]]; then
  echo "Android SDK/NDK not found. Set ANDROID_HOME and NDK_HOME." >&2
  exit 1
fi
export ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK" NDK_HOME
if ! command -v pnpm >/dev/null 2>&1; then
  export PATH="$HOME/.local/share/pnpm/bin:$PATH"
fi
export PATH="$JAVA_HOME/bin:$SDK/platform-tools:$SDK/cmdline-tools/latest/bin:$HOME/.cargo/bin:$PATH"

if ! command -v cargo-tauri >/dev/null 2>&1; then
  echo "cargo-tauri was not found. Install it with: cargo install tauri-cli --version '^2' --locked" >&2
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm was not found." >&2
  exit 1
fi
if ! rustup target list --installed | grep -qx "${TARGET}-linux-android"; then
  rustup target add "${TARGET}-linux-android"
fi

if [[ ! -d "$DESKTOP/src-tauri/gen/android" ]]; then
  echo "== generating the Android project =="
  (cd "$DESKTOP" && cargo tauri android init --ci)
fi

echo "== building $TARGET $MODE ${FORMAT^^} =="
BUILD_ARGS=(--target "$TARGET")
if [[ "$FORMAT" == "apk" ]]; then
  BUILD_ARGS+=(--apk)
else
  BUILD_ARGS+=(--aab)
fi
if [[ "$MODE" == "debug" ]]; then
  BUILD_ARGS+=(--debug)
fi
(cd "$DESKTOP" && cargo tauri android build "${BUILD_ARGS[@]}")

OUT_DIR="$ROOT/dist/android"
mkdir -p "$OUT_DIR"
KEYSTORE="${STOMPSTATION_KEYSTORE:-$HOME/.android/debug.keystore}"
KEY_ALIAS="${STOMPSTATION_KEY_ALIAS:-androiddebugkey}"
STORE_PASS="${STOMPSTATION_KEYSTORE_PASSWORD:-android}"
KEY_PASS="${STOMPSTATION_KEY_PASSWORD:-android}"
if [[ ! -f "$KEYSTORE" ]]; then
  echo "== creating the local debug keystore =="
  mkdir -p "$(dirname "$KEYSTORE")"
  keytool -genkeypair -v \
    -keystore "$KEYSTORE" -storepass "$STORE_PASS" -keypass "$KEY_PASS" \
    -alias "$KEY_ALIAS" -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Android Debug,O=Android,C=US" >/dev/null
fi

if [[ "$FORMAT" == "aab" ]]; then
  OUT="$OUT_DIR/stompstation-$TARGET-release.aab"
  BUNDLE="$(find "$DESKTOP/src-tauri/gen/android/app/build/outputs/bundle" -name '*.aab' -type f 2>/dev/null | sort -V | tail -1)"
  if [[ -z "$BUNDLE" ]]; then
    echo "AAB output was not found under app/build/outputs/bundle." >&2
    exit 1
  fi
  jarsigner -sigalg SHA256withRSA -digestalg SHA-256 \
    -keystore "$KEYSTORE" -storepass "$STORE_PASS" -keypass "$KEY_PASS" \
    -signedjar "$OUT" "$BUNDLE" "$KEY_ALIAS" >/dev/null
  jarsigner -verify "$OUT" >/dev/null
  echo
  echo "AAB: $OUT"
  if [[ -z "${STOMPSTATION_KEYSTORE:-}" ]]; then
    echo "Signed with the local Android debug key — sideload/testing only, not a Play upload key."
  fi
  exit 0
fi

APK_DIR="$DESKTOP/src-tauri/gen/android/app/build/outputs/apk/universal/$MODE"
OUT="$OUT_DIR/stompstation-$TARGET-$MODE.apk"

if [[ "$MODE" == "debug" ]]; then
  install -m 644 "$APK_DIR/app-universal-debug.apk" "$OUT"
else
  BUILD_TOOLS="$(find "$SDK/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -1)"
  ALIGNED="$(mktemp "${TMPDIR:-/tmp}/stompstation-aligned.XXXXXX.apk")"
  trap 'rm -f "$ALIGNED"' EXIT
  "$BUILD_TOOLS/zipalign" -f -p 4 "$APK_DIR/app-universal-release-unsigned.apk" "$ALIGNED"
  "$BUILD_TOOLS/apksigner" sign \
    --ks "$KEYSTORE" --ks-key-alias "$KEY_ALIAS" \
    --ks-pass "pass:$STORE_PASS" --key-pass "pass:$KEY_PASS" \
    --out "$OUT" "$ALIGNED"
  "$BUILD_TOOLS/apksigner" verify "$OUT"
fi

echo
echo "APK: $OUT"
if [[ "$MODE" == "release" && -z "${STOMPSTATION_KEYSTORE:-}" ]]; then
  echo "Signed with the local Android debug key — fine for sideloading, not for Play Store publication."
fi
