---
name: video-frames
description: Extract frames from video files, create thumbnails, generate GIFs from video clips, and analyze video content visually. Use when asked to extract frames, create thumbnails, screenshot at a timestamp, convert to GIF, or analyze video content.
triggers: video frames, extract frames, video thumbnail, screenshot from video, video to gif, analyze video, video clip, video timestamp, ffmpeg, frame extraction
metadata: {"daemora": {"emoji": "🎬", "requires": {"bins": ["ffmpeg"]}, "install": ["brew install ffmpeg"]}}
---

Install: `brew install ffmpeg`

## Get video info

```bash
ffprobe -v quiet -print_format json -show_format -show_streams video.mp4
```

## Extract frame at timestamp

```bash
ffmpeg -ss 00:01:30 -i video.mp4 -vframes 1 -q:v 2 /tmp/frame.png -y -loglevel quiet
```

## Extract frames at regular intervals

```bash
ffmpeg -i video.mp4 -vf "fps=1" /tmp/frames/frame_%04d.png -loglevel quiet
# fps=1 = 1/sec, fps=0.5 = every 2s, fps=2 = 2/sec
```

## Thumbnail (10% into video)

```bash
DURATION=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 video.mp4)
SEEK=$(python3 -c "print(f'{float($DURATION)*0.1:.2f}')")
ffmpeg -ss $SEEK -i video.mp4 -vframes 1 -vf "scale=1280:-1" -q:v 2 /tmp/thumb.jpg -y -loglevel quiet
```

## Video clip → GIF

```bash
ffmpeg -ss 00:00:10 -t 5 -i video.mp4 \
  -vf "fps=12,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" \
  -loop 0 /tmp/clip.gif -y -loglevel quiet
```

## Extract audio

```bash
ffmpeg -i video.mp4 -vn -acodec libmp3lame -q:a 2 /tmp/audio.mp3 -y -loglevel quiet
# Then use transcribeAudio() to transcribe
```

## Analyze video visually

Extract 6-8 evenly-spaced frames, then analyze each with `imageAnalysis(frame, "What's happening here?")`.

## Errors

| Error | Fix |
|-------|-----|
| `ffmpeg: command not found` | `brew install ffmpeg` |
| Blank/black frames | Skip black intro - use a higher timestamp |
| GIF too large | Lower fps (8), smaller width, shorter duration |
