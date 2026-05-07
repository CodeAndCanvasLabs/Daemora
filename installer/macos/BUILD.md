# Building the macOS installer

Must be built on macOS 12+. Linux/Windows can't produce a notarized
`.pkg` because `pkgbuild` and `productbuild` are macOS-only tools.

## Prerequisites

1. **Xcode CLI tools**: `xcode-select --install`
2. (For signing/notarization, optional but strongly recommended for
   non-technical end users) **Apple Developer ID** ($99/yr).
3. `daemora.icns` is checked into both `.app` Resources dirs, generated
   from [`ui/public/favicon.svg`](../../ui/public/favicon.svg). If the
   SVG changes, regenerate with `pnpm run icons:installer`.

## Build (unsigned, for local testing)

```bash
chmod +x installer/macos/build-pkg.sh
installer/macos/build-pkg.sh
```

Output: `installer/macos/dist/Daemora.pkg`.

To test locally: double-click the `.pkg`. Gatekeeper will block it
("cannot be opened because it is from an unidentified developer").
Workaround: System Settings → Privacy & Security → "Open Anyway".

## Build, sign, and notarize (for public release)

```bash
# 1. Build
installer/macos/build-pkg.sh

# 2. Sign
productsign --sign "Developer ID Installer: Your Name (TEAMID)" \
    installer/macos/dist/Daemora.pkg \
    installer/macos/dist/Daemora-signed.pkg

# 3. Notarize (one-time setup: store credentials in keychain)
xcrun notarytool store-credentials NOTARY \
    --apple-id you@example.com \
    --team-id TEAMID \
    --password app-specific-password

xcrun notarytool submit installer/macos/dist/Daemora-signed.pkg \
    --keychain-profile NOTARY --wait

# 4. Staple the notarization ticket so Gatekeeper passes offline too
xcrun stapler staple installer/macos/dist/Daemora-signed.pkg
```

Without notarization: every user has to right-click → Open the first
time. With notarization: double-click works on any Mac, no warnings.

## What the user sees

1. Download `Daemora.pkg` from GitHub Releases, double-click.
2. Standard macOS install wizard: Continue → Continue → Install (asks
   for the user's password — required to write to /Applications).
3. Two `.app` bundles land in /Applications: **Daemora** and **Stop
   Daemora**. A **Daemora** alias appears on the Desktop.
4. Daemora is also dropped into the user's Applications list (Spotlight,
   Launchpad).

## 1-click launch

Double-click **Daemora** on the Desktop (or in /Applications). No
Terminal window. Browser opens to http://localhost:8081 once the server
is ready. The daemon survives browser close, app exit, and user logout.

To stop: double-click **Stop Daemora.app** in /Applications.
