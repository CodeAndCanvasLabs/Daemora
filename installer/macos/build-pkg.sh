#!/bin/bash
#
# Build the macOS Daemora.pkg installer.
#
# Run on macOS 12+ with Xcode CLI tools (`xcode-select --install`).
# Output: installer/macos/dist/Daemora.pkg
#
# What the resulting .pkg does at install time:
#   1. preinstall  -> ensure Homebrew + Node 22 are present
#   2. install     -> copy Daemora.app + "Stop Daemora.app" to /Applications
#   3. postinstall -> npm install -g daemora, place a Daemora alias on the
#                     current user's Desktop
#
# After install, the user double-clicks Daemora.app on the Desktop. No
# Terminal window appears. Daemon spawns hidden via nohup; browser opens
# once /health responds.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DIST="$HERE/dist"
BUILD="$HERE/build"
APP_TEMPLATE="$HERE/app-template"
SCRIPTS="$HERE/scripts"

VERSION="${DAEMORA_VERSION:-1.0.0}"
IDENTIFIER="com.codeandcanvaslabs.daemora"

rm -rf "$DIST" "$BUILD"
mkdir -p "$DIST" "$BUILD/payload/Applications"

# Stage the .app bundles into the payload root.
cp -R "$APP_TEMPLATE/Daemora.app" "$BUILD/payload/Applications/"
cp -R "$APP_TEMPLATE/Stop Daemora.app" "$BUILD/payload/Applications/"

# Make sure the launcher binaries are executable. cp -R preserves the
# perm bits but a fresh checkout from git on Windows won't have them.
chmod +x "$BUILD/payload/Applications/Daemora.app/Contents/MacOS/Daemora"
chmod +x "$BUILD/payload/Applications/Stop Daemora.app/Contents/MacOS/Stop Daemora"

# Make sure the install scripts are executable too.
chmod +x "$SCRIPTS/preinstall" "$SCRIPTS/postinstall"

# Build the component .pkg
pkgbuild \
    --root "$BUILD/payload" \
    --identifier "$IDENTIFIER" \
    --version "$VERSION" \
    --install-location "/" \
    --scripts "$SCRIPTS" \
    "$BUILD/Daemora-component.pkg"

# Wrap in a distribution .pkg (gives the install wizard a real UI)
productbuild \
    --distribution "$HERE/distribution.xml" \
    --package-path "$BUILD" \
    --resources "$HERE/resources" \
    "$DIST/Daemora.pkg"

echo ""
echo "Built: $DIST/Daemora.pkg"
echo ""
echo "Sign with:"
echo "  productsign --sign \"Developer ID Installer: Your Name (TEAMID)\" \\"
echo "    \"$DIST/Daemora.pkg\" \"$DIST/Daemora-signed.pkg\""
echo ""
echo "Notarize with:"
echo "  xcrun notarytool submit \"$DIST/Daemora-signed.pkg\" \\"
echo "    --keychain-profile NOTARY --wait"
echo "  xcrun stapler staple \"$DIST/Daemora-signed.pkg\""
