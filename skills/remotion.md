---
name: remotion
description: Create videos programmatically with Remotion — React components rendered to MP4/WebM/GIF. Supports animations, captions, charts, 3D, transitions, audio, maps.
triggers: remotion, video edit, video creation, animation, render video, create video, mp4, motion graphics, animated, react video, compose video, video editor
---

## How It Works

Remotion = React components → rendered to video frames → encoded to MP4/GIF/WebM.
You write React code, Remotion renders each frame, ffmpeg encodes the output.

## Before Starting

1. Read the master skill file: `readFile("SKILL.md")` — contains index of all rules
2. Read the relevant rule file for your task from `rules/` directory
3. Key rules to read first:
   - `rules/compositions.md` — how to define video compositions
   - `rules/animations.md` — interpolate, spring, easing
   - `rules/sequencing.md` — Sequence, timing, delays
   - `rules/text-animations.md` — text effects, typewriter, word-by-word

## Quick Reference

- Init project: `executeCommand("npx create-video@latest my-video --blank")`
- Preview: `executeCommand("npx remotion preview")`
- Render: `executeCommand("npx remotion render CompositionId out/video.mp4")`
- Single frame check: `executeCommand("npx remotion still CompositionId --frame=30 --scale=0.25")`

## Available Rules (read as needed)

| Rule | When to read |
|---|---|
| `rules/animations.md` | Any animation work |
| `rules/subtitles.md` | Captions, subtitles |
| `rules/audio.md` | Background music, sound |
| `rules/voiceover.md` | AI voiceover (ElevenLabs) |
| `rules/transitions.md` | Scene transitions |
| `rules/charts.md` | Data visualization |
| `rules/3d.md` | Three.js 3D content |
| `rules/maps.md` | Mapbox animated maps |
| `rules/fonts.md` | Google Fonts, custom fonts |
| `rules/tailwind.md` | TailwindCSS styling |
| `rules/images.md` | Embed images |
| `rules/videos.md` | Embed video clips |
| `rules/gifs.md` | GIF support |
| `rules/lottie.md` | Lottie animations |
| `rules/light-leaks.md` | Light leak effects |
| `rules/ffmpeg.md` | FFmpeg operations |
| `rules/silence-detection.md` | Detect/trim silence |

## Workflow

1. Read SKILL.md + relevant rules
2. `writeFile` — create React components for each scene
3. `writeFile` — register compositions in Root.tsx
4. `executeCommand("npx remotion still ...")` — verify single frame
5. `executeCommand("npx remotion render ...")` — full render
6. `sendFile` — deliver result to user
