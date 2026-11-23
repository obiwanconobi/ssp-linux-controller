#!/usr/bin/env bash
# Stop local Android test emulators and the host simulator.
#
# This is a cleanup helper for processes left by android-e2e.sh or a manual
# test run. It targets local emulator-* devices only and the simulator port.
#
#   ./scripts/android-stop.sh
#   ANDROID_SERIAL=emulator-5554 ./scripts/android-stop.sh
set -euo pipefail

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
SIM_PORT="${STOMP_SIM_PORT:-45700}"
ADB="$SDK/platform-tools/adb"

if [[ -x "$ADB" ]]; then
  if [[ -n "${ANDROID_SERIAL:-}" ]]; then
    serials=("$ANDROID_SERIAL")
  else
    mapfile -t serials < <(
      "$ADB" devices | awk 'NR > 1 && $2 == "device" && $1 ~ /^emulator-/ { print $1 }'
    )
  fi

  for serial in "${serials[@]}"; do
    echo "Stopping $serial"
    "$ADB" -s "$serial" emu kill >/dev/null 2>&1 || true
  done
  "$ADB" reverse --remove "tcp:$SIM_PORT" >/dev/null 2>&1 || true
else
  echo "adb not found at $ADB" >&2
fi

# Match the executable name rather than `pkill -f`: the latter also matches a
# caller whose command line happens to contain the simulator arguments.
sim_pids=()
while read -r pid; do
  [[ -r "/proc/$pid/cmdline" ]] || continue
  cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline")"
  [[ "$cmdline" == *"stomp-sim --port $SIM_PORT"* ]] || continue
  sim_pids+=("$pid")
done < <(pgrep -x stomp-sim || true)

if ((${#sim_pids[@]} > 0)); then
  echo "Stopping stomp-sim on port $SIM_PORT"
  kill "${sim_pids[@]}" 2>/dev/null || true
fi

echo "Android test processes stopped."
