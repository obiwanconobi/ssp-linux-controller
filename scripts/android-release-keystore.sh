#!/usr/bin/env bash
# Generate the Android release signing key used by the GitHub release workflow.
#
#   ./scripts/android-release-keystore.sh [output.jks] [alias]
#
# The keystore is created outside the repository by default
# (~/.android/stompstation-release.jks) so it cannot be committed by accident.
# Back it up together with the passwords, then add the four repository secrets
# printed at the end.
#
# Set STOMPSTATION_KEYSTORE_PASSWORD and STOMPSTATION_KEY_PASSWORD to run
# non-interactively (for automation); otherwise keytool prompts for them.
set -euo pipefail

OUT="${1:-$HOME/.android/stompstation-release.jks}"
ALIAS="${2:-stompstation}"

if ! command -v keytool >/dev/null 2>&1 && [[ -n "${JAVA_HOME:-}" && -x "$JAVA_HOME/bin/keytool" ]]; then
  PATH="$JAVA_HOME/bin:$PATH"
fi
if ! command -v keytool >/dev/null 2>&1 && [[ -x /opt/android-studio/jbr/bin/keytool ]]; then
  PATH="/opt/android-studio/jbr/bin:$PATH"
fi
if ! command -v keytool >/dev/null 2>&1 && [[ -x "/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/keytool" ]]; then
  PATH="/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin:$PATH"
fi

if ! command -v keytool >/dev/null 2>&1; then
  echo "keytool was not found. Install a JDK (17+) or set JAVA_HOME so keytool is on PATH." >&2
  exit 1
fi

if [[ -e "$OUT" ]]; then
  echo "Refusing to overwrite existing keystore: $OUT" >&2
  echo "Move or delete it first if you really want to create a new signing key." >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"

echo "Generating a 4096-bit RSA release keystore:"
echo "  keystore: $OUT"
echo "  alias:    $ALIAS"
echo

KEYTOOL_ARGS=(
  -genkeypair -v
  -keystore "$OUT"
  -storetype JKS
  -alias "$ALIAS"
  -keyalg RSA
  -keysize 4096
  -validity 10000
  -dname "CN=StompStation, O=StompStation, C=US"
)
if [[ -n "${STOMPSTATION_KEYSTORE_PASSWORD:-}" ]]; then
  KEYTOOL_ARGS+=(-storepass "$STOMPSTATION_KEYSTORE_PASSWORD")
fi
if [[ -n "${STOMPSTATION_KEY_PASSWORD:-}" ]]; then
  KEYTOOL_ARGS+=(-keypass "$STOMPSTATION_KEY_PASSWORD")
elif [[ -n "${STOMPSTATION_KEYSTORE_PASSWORD:-}" ]]; then
  KEYTOOL_ARGS+=(-keypass "$STOMPSTATION_KEYSTORE_PASSWORD")
fi

keytool "${KEYTOOL_ARGS[@]}"
chmod 600 "$OUT"

B64="$OUT.b64"
if base64 --help 2>&1 | grep -q -- '-w'; then
  base64 -w0 "$OUT" > "$B64"
else
  base64 "$OUT" | tr -d '\n' > "$B64"
fi

cat <<EOF

Keystore created.

Back up BOTH the keystore and its passwords somewhere safe. Android requires
every update to be signed with this same key; if it is lost, existing installs
cannot be updated through Obtainium and must be uninstalled and reinstalled.

Base64 file: $B64

Add the repository secrets with the GitHub CLI. The names below are fixed
secret names; gh prompts for each password value. Do not replace a secret
name with the password itself.

  # Base64 keystore contents (read from the file)
  gh secret set ANDROID_KEYSTORE_BASE64 < "$B64"

  # Key alias used when the keystore was created
  gh secret set ANDROID_KEY_ALIAS --body "$ALIAS"

  # Paste the keystore password when prompted
  # (keytool asked: "Enter keystore password")
  gh secret set ANDROID_KEYSTORE_PASSWORD

  # Paste the key password when prompted
  # (keytool asked: "Enter key password for $ALIAS").
  # If you pressed Enter there, reuse the keystore password.
  gh secret set ANDROID_KEY_PASSWORD

Or add them in GitHub: Settings -> Secrets and variables -> Actions ->
New repository secret. Paste the contents of "$B64" for
ANDROID_KEYSTORE_BASE64, and enter the matching password as the secret value
for the two password entries.

After adding the secrets, delete the Base64 file:

  rm "$B64"

Never commit the keystore or its passwords.
EOF
