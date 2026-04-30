# Video Editor Template

Pre-baked Remotion scaffold the `video-editor` crew copies for every render. Avoids the slow / network-flaky `npx create-video` bootstrap.

## Workflow (the agent does this — humans don't need to run any of it)

```bash
# 1. Copy template to a new project dir
cp -R crew/video-editor/template data/video-projects/<job-name>

# 2. First-time-only: install deps (re-uses any existing data/video-projects/_shared/node_modules if present)
cd data/video-projects/<job-name> && pnpm install

# 3. Drop assets into ./public/
cp /path/to/asset.png public/

# 4. Edit src/Video.tsx (or add new scene files + register in Root.tsx)

# 5. Render
npx remotion render Video out/video.mp4 --codec=h264

# 6. Move final to journal
mv out/video.mp4 ../../journal/artifacts/<date>/short.mp4
```

## What the template gives you

- `package.json` with Remotion 4.x already pinned
- `tsconfig.json` configured for ESM + JSX
- `remotion.config.ts` with sensible defaults
- `src/Root.tsx` with a default `<Composition id="Video" />` registered (1080×1920 vertical, 30 fps, 30 sec)
- `src/Video.tsx` placeholder scene driven by `useCurrentFrame()`
- `src/index.ts` registers Root

The agent overwrites `src/Video.tsx` (and adds new scene files) for each job; `Root.tsx` and config stay stable.

## Rules baked in

- All animation via `useCurrentFrame()` — no CSS transitions
- Default canvas 1080×1920 vertical (TikTok / YT Shorts)
- 30 fps, 30 sec default duration — change in `Root.tsx` if needed
- Static assets must live under `./public/` and load via `staticFile("name.png")`
