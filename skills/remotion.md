---
name: remotion
description: Create videos programmatically with Remotion — React components rendered to MP4/WebM/GIF
triggers: remotion, video, animation, render video, create video, mp4, motion graphics, animated, video generation, react video
---

## Project Setup
- Init: `executeCommand("npx create-video@latest my-video --blank")`
- Or add to existing: `executeCommand("npm install remotion @remotion/cli @remotion/bundler")`
- Structure:
  ```
  src/
    Root.tsx          # registerRoot — lists all compositions
    Composition.tsx   # <Composition> definitions (id, fps, duration, size)
    MyVideo.tsx       # actual video component
  ```

## Composition Registration
```tsx
// Root.tsx
import { Composition } from "remotion";
import { MyVideo } from "./MyVideo";

export const RemotionRoot = () => (
  <Composition
    id="MyVideo"
    component={MyVideo}
    durationInFrames={150}  // 5 sec at 30fps
    fps={30}
    width={1920}
    height={1080}
    defaultProps={{ title: "Hello" }}
  />
);
```

## Animation Patterns
- `useCurrentFrame()` — current frame number
- `useVideoConfig()` — `{ fps, durationInFrames, width, height }`
- `interpolate(frame, [0, 30], [0, 1])` — map frame range to value range
- `spring({ frame, fps, config: { damping: 200 } })` — spring physics
- `<Sequence from={30} durationInFrames={60}>` — time-slice children
- `<AbsoluteFill>` — full-screen positioned container
- `<Img src={staticFile("bg.png")} />` — static assets from `public/`

## Common Effects
- Fade in: `opacity: interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" })`
- Slide in: `transform: \`translateX(\${interpolate(frame, [0, 30], [-100, 0])}%)\``
- Scale: `transform: \`scale(\${spring({ frame, fps })})\``
- Typewriter: `text.slice(0, Math.floor(frame / 2))`

## Audio & Video
- `<Audio src={staticFile("music.mp3")} volume={0.5} />`
- `<Video src={staticFile("clip.mp4")} />`
- `<OffthreadVideo src={url} />` — for remote/heavy videos

## Rendering
- Preview: `executeCommand("npx remotion preview")`
- Render MP4: `executeCommand("npx remotion render MyVideo out/video.mp4")`
- Render GIF: `executeCommand("npx remotion render MyVideo out/video.gif --image-format png")`
- Custom settings: `npx remotion render MyVideo out.mp4 --codec h264 --crf 18 --scale 2`
- Specific frames: `--frames=0-90`
- Concurrency: `--concurrency=4`

## Workflow
1. `writeFile` — create/edit React components for each scene
2. `writeFile` — register compositions in Root.tsx
3. `executeCommand("npx remotion render ...")` — render to file
4. `sendFile(outputPath, channelId, sessionId)` — deliver result

## Rules
- Keep compositions pure — no side effects in render
- Use `staticFile()` for local assets (place in `public/`)
- Use `delayRender()` / `continueRender()` for async data loading
- Test with preview before final render
- Default to 1080p 30fps unless user specifies otherwise
