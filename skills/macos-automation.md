---
name: macos-automation
description: macOS automation via AppleScript/osascript — window management, app control, system prefs, Finder
triggers: macos, applescript, osascript, window, finder, system preferences, notification, clipboard, screenshot, spotlight, automator, open app, close app, resize window
---

## Running AppleScript
- Via executeCommand: `executeCommand("osascript -e 'tell application \"Finder\" to activate'")`
- Multi-line: `writeFile("/tmp/script.scpt", script)` then `executeCommand("osascript /tmp/script.scpt")`
- JavaScript (JXA): `executeCommand("osascript -l JavaScript -e 'Application(\"Finder\").activate()'")`

## App Control
- Open: `osascript -e 'tell application "Safari" to activate'`
- Quit: `osascript -e 'tell application "Safari" to quit'`
- Quit all: `osascript -e 'tell application "System Events" to set quitApps to name of every application process whose background only is false'`
- Launch with file: `open -a "Preview" /path/to/file.pdf`
- Check running: `osascript -e 'tell application "System Events" to (name of processes) contains "Safari"'`

## Window Management
- List windows: `osascript -e 'tell application "System Events" to tell process "AppName" to get {name, position, size} of every window'`
- Move window: `osascript -e 'tell application "System Events" to tell process "AppName" to set position of window 1 to {0, 0}'`
- Resize: `osascript -e 'tell application "System Events" to tell process "AppName" to set size of window 1 to {1200, 800}'`
- Minimize: `osascript -e 'tell application "System Events" to tell process "AppName" to set miniaturized of window 1 to true'`
- Fullscreen: `osascript -e 'tell application "System Events" to tell process "AppName" to set value of attribute "AXFullScreen" of window 1 to true'`

## Finder Operations
- Open folder: `osascript -e 'tell application "Finder" to open folder "Documents" of home'`
- Get selection: `osascript -e 'tell application "Finder" to get selection as alias list'`
- New folder: `osascript -e 'tell application "Finder" to make new folder at desktop with properties {name:"NewFolder"}'`
- Reveal file: `open -R /path/to/file`
- Trash file: `osascript -e 'tell application "Finder" to delete POSIX file "/path/to/file"'`

## System
- Notification: `osascript -e 'display notification "Body" with title "Title" sound name "Glass"'`
- Dialog: `osascript -e 'display dialog "Question?" buttons {"No","Yes"} default button "Yes"'`
- Clipboard get: `executeCommand("pbpaste")`
- Clipboard set: `executeCommand("echo 'text' | pbcopy")`
- Screenshot: `executeCommand("screencapture -x /tmp/screen.png")` — silent full screen
- Screenshot region: `executeCommand("screencapture -ix /tmp/region.png")` — interactive select
- Volume: `osascript -e 'set volume output volume 50'` (0-100)
- Mute: `osascript -e 'set volume output muted true'`
- Dark mode: `osascript -e 'tell application "System Events" to tell appearance preferences to set dark mode to true'`

## Keyboard & Mouse
- Keystroke: `osascript -e 'tell application "System Events" to keystroke "a" using command down'`
- Key code: `osascript -e 'tell application "System Events" to key code 36'` (return)
- Common key codes: 36 (return), 48 (tab), 49 (space), 51 (delete), 53 (escape), 123-126 (arrows)

## Spotlight / Open
- Open URL: `executeCommand("open https://example.com")`
- Open file: `executeCommand("open /path/to/file")`
- Open with app: `executeCommand("open -a 'Visual Studio Code' /path")`
- Search Spotlight: `executeCommand("mdfind 'query'")`
- Find by name: `executeCommand("mdfind -name 'filename'")`

## Rules
- Always use `executeCommand` — never run osascript directly
- Quote inner AppleScript strings with `\"` (escaped within the command string)
- For complex multi-line scripts, write to `/tmp/` first then execute
- Test scripts before chaining destructive operations
- Some actions require Accessibility permissions (System Settings > Privacy)
- Prefer `open` CLI over AppleScript for simple file/URL/app launches
