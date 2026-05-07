# Daemora installers

One-click installers for non-technical users. Two platforms, same UX:

```
Download installer  →  Run it  →  Click "Daemora" on Desktop  →  Web UI opens
```

No terminal. No `npm install -g`. No `daemora setup`. The web UI handles
all configuration on first run.

## Layout

```
installer/
├── windows/                Inno Setup project -> DaemoraSetup.exe
│   ├── daemora.iss
│   ├── launcher.ps1
│   ├── assets/             (drop daemora.ico here)
│   └── BUILD.md
└── macos/                  pkgbuild project -> Daemora.pkg
    ├── build-pkg.sh
    ├── distribution.xml
    ├── scripts/
    │   ├── preinstall
    │   └── postinstall
    ├── app-template/
    │   ├── Daemora.app/
    │   └── Stop Daemora.app/
    ├── resources/          (welcome.html, license.html, etc.)
    └── BUILD.md
```

## What the installer does

1. **Detects Node.js 22+** — installs it if missing.
   - Windows: `winget install OpenJS.NodeJS.LTS`, fallback to MSI download.
   - macOS: Homebrew (auto-installs brew if missing) + `brew install node@22`.
2. **`npm install -g daemora`**.
3. **Drops a launcher + shortcuts**:
   - Windows: `launcher.ps1` in install dir, shortcuts on Start Menu + Desktop.
   - macOS: `Daemora.app` and `Stop Daemora.app` in /Applications, alias on Desktop.

## Lifecycle

- **Start** (1-click): double-click the Daemora icon. If the daemon isn't
  running, it spawns hidden (no Terminal/PowerShell window), waits for
  `/health`, then opens the browser. If already running, just opens
  the browser.
- **Closing the browser does NOT stop Daemora.** The daemon is detached
  and survives browser close, launcher exit, and even user logout.
- **Stop**: separate "Stop Daemora" shortcut/app. Reads the PID file
  in the data dir and kills the process tree. Falls back to killing
  whatever's bound to port 8081 if the PID file is stale.

## Data dir

Daemora resolves its data dir to the OS-standard app dir automatically
(see [src/config/env.ts](../src/config/env.ts)):

- Windows: `%APPDATA%\Daemora\` (= `C:\Users\<user>\AppData\Roaming\Daemora`)
- macOS:   `~/Library/Application Support/Daemora/`

The launcher writes `daemora.pid` and `daemora.log` to the same dir, so
all per-user state lives in one place. Uninstalling the app does not
delete the data dir — user state survives reinstalls.

## Build

See [`windows/BUILD.md`](windows/BUILD.md) and [`macos/BUILD.md`](macos/BUILD.md).

The Windows installer is built with Inno Setup on a Windows machine.
The macOS installer needs `pkgbuild` / `productbuild`, which are
macOS-only. CI: GitHub Actions has both `windows-latest` and
`macos-latest` runners that can produce both artifacts in one workflow.

## Code signing

Both platforms warn loudly on unsigned installers. Strongly recommended
for non-technical users — tells the OS "this came from us, run it".

| Platform | Cert | Cost | What you get |
|---|---|---|---|
| Windows | EV code-signing | $200–400/yr | No SmartScreen warning at all |
| Windows | Standard OV | $80–200/yr | Warning clears once enough users install it (reputation) |
| macOS   | Developer ID + notarization | $99/yr | No Gatekeeper warning; "Open" works on first try |

Without signing, expect the user to click through one OS warning on
their first install. After install, every subsequent launch is silent.

## Release process

1. Bump version in [`package.json`](../package.json).
2. Bump `AppVersion` in [`windows/daemora.iss`](windows/daemora.iss) and
   `version` in [`macos/distribution.xml`](macos/distribution.xml).
3. `npm publish` (so `npm install -g daemora` resolves the new version).
4. Build both installers (CI or locally on each OS).
5. Sign + notarize.
6. Upload `DaemoraSetup.exe` and `Daemora.pkg` to GitHub Releases.
7. Update README download links.
