---
name: remotion
description: Create and edit videos programmatically with Remotion - React components rendered to MP4/WebM/GIF. Branded reels, animated mockups, motion graphics, captions, charts, 3D, transitions, voiceover, and editing existing recordings.
triggers: remotion, video, video creation, video edit, animation, render video, create video, mp4, motion graphics, animated, react video, compose video, branded video, brand video, mockup, demo reel, promo, intro, outro, title sequence, logo reveal, reel, social reel, tiktok, captions, subtitles, voiceover, background music, sound effects, audiogram, audio visualization, chart animation, 3d video, motion design
metadata:
  tags: remotion, video, react, animation, composition, branding, mockup, motion-graphics
---

## When to use

Use this skill whenever you are creating or editing videos with Remotion to obtain the domain-specific knowledge.

## New project setup

When starting a video task, scaffold a fresh Remotion project under `data/video-projects/<name>/`:

```bash
npx create-video@latest --yes --blank --no-tailwind <name>
```

NEVER use the cloned Remotion repo at `agents/remotion/` - that is the source code of Remotion itself, not a video project.
Copy source media files into the project's `public/` folder before referencing them with `staticFile()`.

## Starting preview

Start the Remotion Studio to preview a video:

```bash
npx remotion studio
```

## Optional: one-frame render check

Render a single frame with the CLI to sanity-check layout, colors, or timing.
Skip it for trivial edits, pure refactors, or when you already have enough confidence from Studio or prior renders.

```bash
npx remotion still [composition-id] --scale=0.25 --frame=30
```

At 30 fps, `--frame=30` is the one-second mark (`--frame` is zero-based).

## Captions

When dealing with captions or subtitles, load the [crew/video-editor/rules/subtitles.md](../crew/video-editor/rules/subtitles.md) file for more information.

## Using FFmpeg

For some video operations, such as trimming videos or detecting silence, FFmpeg should be used. Load the [crew/video-editor/rules/ffmpeg.md](../crew/video-editor/rules/ffmpeg.md) file for more information.

## Silence detection

When needing to detect and trim silent segments from video or audio files, load the [crew/video-editor/rules/silence-detection.md](../crew/video-editor/rules/silence-detection.md) file.

## Audio visualization

When needing to visualize audio (spectrum bars, waveforms, bass-reactive effects), load the [crew/video-editor/rules/audio-visualization.md](../crew/video-editor/rules/audio-visualization.md) file for more information.

## Sound effects

When needing to use sound effects, load the [crew/video-editor/rules/sfx.md](../crew/video-editor/rules/sfx.md) file for more information.

## Editing existing videos

To edit a recorded video (add music, captions, effects, overlays, trim):
1. Load [crew/video-editor/rules/videos.md](../crew/video-editor/rules/videos.md) - embed source via `<Video src={staticFile("input.mp4")}>`
2. Load [crew/video-editor/rules/audio.md](../crew/video-editor/rules/audio.md) - layer music: `<Audio src={staticFile("music.mp3")} volume={0.3}>`
3. Load [crew/video-editor/rules/display-captions.md](../crew/video-editor/rules/display-captions.md) - overlay TikTok-style captions with word highlighting
4. Load [crew/video-editor/rules/transitions.md](../crew/video-editor/rules/transitions.md) - add scene transitions
5. Load [crew/video-editor/rules/trimming.md](../crew/video-editor/rules/trimming.md) - cut start/end of clips

Source video = base layer. Text, images, audio, effects = additional layers via `<Sequence>`.

## Generating assets with AI

When the user needs assets that don't exist yet:
- `generateMusic(prompt, duration)` - AI-generated background music or soundtracks
- `generateImage(prompt)` - AI-generated scene backgrounds, thumbnails, overlays
- `textToSpeech(text)` - generate narration audio for voiceover scenes
- `transcribeAudio(audioPath)` - generate captions from speech audio
- `imageOps(inputPath, operation)` - resize, crop, convert images for scene assets

## How to use

Read individual rule files for detailed explanations and code examples:

- [crew/video-editor/rules/3d.md](../crew/video-editor/rules/3d.md) - 3D content in Remotion using Three.js and React Three Fiber
- [crew/video-editor/rules/animations.md](../crew/video-editor/rules/animations.md) - Fundamental animation skills for Remotion
- [crew/video-editor/rules/assets.md](../crew/video-editor/rules/assets.md) - Importing images, videos, audio, and fonts into Remotion
- [crew/video-editor/rules/audio.md](../crew/video-editor/rules/audio.md) - Using audio and sound in Remotion - importing, trimming, volume, speed, pitch
- [crew/video-editor/rules/calculate-metadata.md](../crew/video-editor/rules/calculate-metadata.md) - Dynamically set composition duration, dimensions, and props
- [crew/video-editor/rules/can-decode.md](../crew/video-editor/rules/can-decode.md) - Check if a video can be decoded by the browser using Mediabunny
- [crew/video-editor/rules/charts.md](../crew/video-editor/rules/charts.md) - Chart and data visualization patterns for Remotion (bar, pie, line, stock charts)
- [crew/video-editor/rules/compositions.md](../crew/video-editor/rules/compositions.md) - Defining compositions, stills, folders, default props and dynamic metadata
- [crew/video-editor/rules/display-captions.md](../crew/video-editor/rules/display-captions.md) - TikTok-style captions with word highlighting
- [crew/video-editor/rules/extract-frames.md](../crew/video-editor/rules/extract-frames.md) - Extract frames from videos at specific timestamps using Mediabunny
- [crew/video-editor/rules/fonts.md](../crew/video-editor/rules/fonts.md) - Loading Google Fonts and local fonts in Remotion
- [crew/video-editor/rules/get-audio-duration.md](../crew/video-editor/rules/get-audio-duration.md) - Getting the duration of an audio file in seconds with Mediabunny
- [crew/video-editor/rules/get-video-dimensions.md](../crew/video-editor/rules/get-video-dimensions.md) - Getting the width and height of a video file with Mediabunny
- [crew/video-editor/rules/get-video-duration.md](../crew/video-editor/rules/get-video-duration.md) - Getting the duration of a video file in seconds with Mediabunny
- [crew/video-editor/rules/gifs.md](../crew/video-editor/rules/gifs.md) - Displaying GIFs synchronized with Remotion's timeline
- [crew/video-editor/rules/images.md](../crew/video-editor/rules/images.md) - Embedding images in Remotion using the Img component
- [crew/video-editor/rules/import-srt-captions.md](../crew/video-editor/rules/import-srt-captions.md) - Import SRT subtitle files into Remotion
- [crew/video-editor/rules/light-leaks.md](../crew/video-editor/rules/light-leaks.md) - Light leak overlay effects using @remotion/light-leaks
- [crew/video-editor/rules/lottie.md](../crew/video-editor/rules/lottie.md) - Embedding Lottie animations in Remotion
- [crew/video-editor/rules/maps.md](../crew/video-editor/rules/maps.md) - Add a map using Mapbox and animate it
- [crew/video-editor/rules/measuring-dom-nodes.md](../crew/video-editor/rules/measuring-dom-nodes.md) - Measuring DOM element dimensions in Remotion
- [crew/video-editor/rules/measuring-text.md](../crew/video-editor/rules/measuring-text.md) - Measuring text dimensions, fitting text to containers, and checking overflow
- [crew/video-editor/rules/parameters.md](../crew/video-editor/rules/parameters.md) - Make a video parametrizable by adding a Zod schema
- [crew/video-editor/rules/sequencing.md](../crew/video-editor/rules/sequencing.md) - Sequencing patterns for Remotion - delay, trim, limit duration of items
- [crew/video-editor/rules/sfx.md](../crew/video-editor/rules/sfx.md) - Including sound effects (whoosh, click, ding, vine boom)
- [crew/video-editor/rules/silence-detection.md](../crew/video-editor/rules/silence-detection.md) - Adaptive silence detection using FFmpeg loudnorm and silencedetect
- [crew/video-editor/rules/subtitles.md](../crew/video-editor/rules/subtitles.md) - General subtitle rendering
- [crew/video-editor/rules/tailwind.md](../crew/video-editor/rules/tailwind.md) - Using TailwindCSS in Remotion
- [crew/video-editor/rules/text-animations.md](../crew/video-editor/rules/text-animations.md) - Typography and text animation patterns for Remotion
- [crew/video-editor/rules/timing.md](../crew/video-editor/rules/timing.md) - Timing with interpolate and Bezier easing, springs
- [crew/video-editor/rules/transitions.md](../crew/video-editor/rules/transitions.md) - Scene transition patterns for Remotion
- [crew/video-editor/rules/transparent-videos.md](../crew/video-editor/rules/transparent-videos.md) - Rendering out a video with transparency
- [crew/video-editor/rules/transcribe-captions.md](../crew/video-editor/rules/transcribe-captions.md) - Generate captions from audio via Whisper
- [crew/video-editor/rules/trimming.md](../crew/video-editor/rules/trimming.md) - Trimming patterns for Remotion - cut the beginning or end of animations
- [crew/video-editor/rules/videos.md](../crew/video-editor/rules/videos.md) - Embedding videos in Remotion - trimming, volume, speed, looping, pitch
- [crew/video-editor/rules/voiceover.md](../crew/video-editor/rules/voiceover.md) - Adding AI-generated voiceover to Remotion compositions using ElevenLabs TTS
- [crew/video-editor/rules/cursor-and-clicks.md](../crew/video-editor/rules/cursor-and-clicks.md) - Animated cursor pointer, travel paths, and click feedback for product demo videos
- [crew/video-editor/rules/focus-zoom.md](../crew/video-editor/rules/focus-zoom.md) - Zoom into a specific UI element and back for product demo emphasis
- [crew/video-editor/rules/theme-switching.md](../crew/video-editor/rules/theme-switching.md) - Dark/light theme toggle animations with in-place cross-fade
- [crew/video-editor/rules/ui-chrome.md](../crew/video-editor/rules/ui-chrome.md) - Rendering realistic device frames (macbook, phone, browser) with 3D perspective and inner screens
