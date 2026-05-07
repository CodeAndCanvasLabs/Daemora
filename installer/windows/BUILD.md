# Building the Windows installer

## Prerequisites

1. **Inno Setup 6+** — download from https://jrsoftware.org/isinfo.php (free).
2. `assets/daemora.ico` is checked into the repo, generated from
   [`ui/public/favicon.svg`](../../ui/public/favicon.svg). If the SVG ever
   changes, regenerate with `pnpm run icons:installer`.

## Build

From a Command Prompt or PowerShell at the repo root:

```cmd
"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\windows\daemora.iss
```

Output: `installer\windows\Output\DaemoraSetup.exe`.

## Test on a clean machine

The installer auto-installs Node.js if missing, so test on a VM or a
machine without Node to verify the bootstrap path. Either:

- Uninstall Node first (`winget uninstall OpenJS.NodeJS.LTS`), then run
  `DaemoraSetup.exe`.
- Or use a Windows Sandbox / Hyper-V VM.

## What the user sees

1. Double-click `DaemoraSetup.exe`.
2. SmartScreen warning ("Windows protected your PC") — unsigned binaries
   trigger this. User clicks **More info → Run anyway**. Sign the binary
   with an EV code-signing certificate to remove this warning (~$200/yr).
3. Standard Inno wizard: license → install dir → desktop-shortcut
   checkbox → install.
4. Progress page does its thing: "Installing Node.js...", "Installing
   Daemora via npm..." — usually 1–3 minutes total on a fresh machine.
5. Final page has a **Launch Daemora** checkbox (default on). Click
   Finish; Daemora starts hidden, the browser opens to
   `http://localhost:8081`, and the user finishes setup in the web UI.

## Subsequent launches

Desktop shortcut → silent start (no PowerShell window) → browser opens.
The daemon survives browser close, launcher exit, and user logout.

## Code signing (optional, recommended)

```cmd
signtool sign /tr http://timestamp.digicert.com /td sha256 /fd sha256 ^
  /a Output\DaemoraSetup.exe
```

Without signing, expect SmartScreen friction on every install. EV certs
($200–400/yr) clear SmartScreen reputation immediately; standard OV
certs need to accumulate downloads before SmartScreen trusts them.
