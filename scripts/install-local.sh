#!/usr/bin/env bash
# Build and install StompStation for the current user.
#
#   ./scripts/install-local.sh
#
# Installs:
#   ~/.local/bin/stompstation
#   ~/.local/share/applications/stompstation.desktop
#   ~/.local/share/icons/hicolor/{128x128,512x512}/apps/stompstation.png
#
# Re-run the same command after changing the UI or Rust code; it rebuilds the
# embedded production frontend and replaces the installed binary.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UI="$ROOT/apps/desktop/ui"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
APP_ID="stompstation"

if ! command -v pnpm >/dev/null 2>&1; then
  export PATH="$HOME/.local/share/pnpm/bin:$PATH"
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm was not found. Install it with: curl -fsSL https://get.pnpm.io/install.sh | sh -" >&2
  exit 1
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo was not found. Install Rust from https://rustup.rs" >&2
  exit 1
fi

echo "== building the frontend =="
(cd "$UI" && pnpm build)

echo "== building the release desktop binary =="
(cd "$ROOT" && cargo build --release --locked --features custom-protocol -p stompstation-desktop)

echo "== installing to $BIN_DIR =="
mkdir -p "$BIN_DIR" "$DATA_HOME/applications" \
  "$DATA_HOME/icons/hicolor/128x128/apps" \
  "$DATA_HOME/icons/hicolor/512x512/apps"
install -m 755 "$ROOT/target/release/stompstation-desktop" "$BIN_DIR/stompstation"
install -m 644 "$ROOT/apps/desktop/src-tauri/icons/128x128.png" \
  "$DATA_HOME/icons/hicolor/128x128/apps/$APP_ID.png"
install -m 644 "$ROOT/apps/desktop/src-tauri/icons/icon.png" \
  "$DATA_HOME/icons/hicolor/512x512/apps/$APP_ID.png"

sed "s#^Exec=.*#Exec=$BIN_DIR/stompstation#" \
  "$ROOT/packaging/linux/stompstation.desktop" \
  > "$DATA_HOME/applications/$APP_ID.desktop"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DATA_HOME/applications" >/dev/null 2>&1 || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "$DATA_HOME/icons/hicolor" >/dev/null 2>&1 || true
fi

echo
echo "Installed: $BIN_DIR/stompstation"
echo "Launch it from the application menu or run: $BIN_DIR/stompstation"
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo "Note: $BIN_DIR is not in PATH; use the absolute path above or add it to your shell profile."
fi
echo "Device access: see packaging/linux/70-stompstation.rules if /dev/ttyACM0 is not accessible."
