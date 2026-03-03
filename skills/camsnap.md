---
name: camsnap
description: Capture photos or screenshots from the Mac camera or screen. Use when the user asks to take a photo, capture a webcam shot, take a selfie, capture the screen, or grab a camera frame. macOS only.
triggers: take photo, camera, webcam, selfie, snap photo, capture camera, camsnap, take picture, camera shot, photo capture
metadata: {"daemora": {"emoji": "📸", "requires": {"bins": ["imagesnap"]}, "install": ["brew install imagesnap"], "os": ["darwin"]}}
---

## Screen capture

Use the built-in `screenCapture` tool - no install needed.

## Webcam

Install: `brew install imagesnap`

```bash
imagesnap -w 2 /tmp/photo.jpg              # take photo (2s warmup)
imagesnap -l                               # list available cameras
imagesnap -d "iPhone Camera" /tmp/photo.jpg  # specific camera
imagesnap -t 1 /tmp/burst                  # burst: one shot per second
```

## Workflow

1. Screen → `screenCapture("/tmp/screen.png")`
2. Webcam → check `imagesnap` installed, then run with `-w 2` warmup
3. Report the saved path
4. If user asked to "look at" or "check" something → auto-run `imageAnalysis(path, "What do you see?")`
5. To send → `sendFile(path, channel, sessionId)`

## Errors

| Error | Fix |
|-------|-----|
| `imagesnap: command not found` | `brew install imagesnap` |
| Black/dark photo | Increase warmup: `-w 3` (camera needs time to adjust) |
| Camera busy | Close FaceTime/Zoom/Photo Booth |
| Permission denied | System Settings → Privacy → Camera → enable Terminal |
