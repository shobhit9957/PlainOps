#!/usr/bin/env bash
# PlainOps macOS installer.
#
# Why this exists: browser downloads get macOS's quarantine flag, and without
# Apple notarization Gatekeeper then shows "damaged and can't be opened".
# Terminal downloads are NOT quarantined — so this script installs cleanly on
# every current macOS, Apple Silicon and Intel, with no warning dialogs.
#
#   curl -fsSL https://raw.githubusercontent.com/shobhit9957/PlainOps/main/scripts/install-mac.sh | bash
set -euo pipefail

REPO="shobhit9957/PlainOps"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  ASSET="PlainOps-mac-arm64.zip" ;;
  x86_64) ASSET="PlainOps-mac-x64.zip" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading PlainOps ($ASSET)…"
curl -fL --progress-bar "https://github.com/$REPO/releases/latest/download/$ASSET" -o "$TMP/PlainOps.zip"

echo "Installing to /Applications…"
ditto -xk "$TMP/PlainOps.zip" "$TMP/extract"
rm -rf "/Applications/PlainOps.app"
ditto "$TMP/extract/PlainOps.app" "/Applications/PlainOps.app"
xattr -rc "/Applications/PlainOps.app" 2>/dev/null || true

echo "Done — launching PlainOps."
open "/Applications/PlainOps.app"
