---
name: gif-search
description: Search for GIFs, download and send animated GIFs, create GIFs from images or video. Use when the user asks for a GIF, wants to find a reaction GIF, send a GIF, or create a GIF from video.
triggers: gif, find gif, send gif, reaction gif, funny gif, animated gif, search gif, giphy, tenor, make gif, create gif
metadata: {"daemora": {"emoji": "🎭"}}
---

## Search Tenor (no API key needed)

```bash
curl -s "https://tenor.googleapis.com/v2/search?q=happy+dance&key=LIVDSRZULELA&limit=5&media_filter=minimal" \
  | python3 -c "import sys,json; [print(r['media_formats']['gif']['url']) for r in json.load(sys.stdin)['results']]"
```

## Search Giphy (free key at developers.giphy.com)

```bash
curl -s "https://api.giphy.com/v1/gifs/search?q=celebration&api_key=$GIPHY_API_KEY&limit=5&rating=g" \
  | python3 -c "import sys,json; [print(g['images']['original']['url']) for g in json.load(sys.stdin)['data']]"
```

## Download GIF

```bash
curl -L -o /tmp/reaction.gif "GIF_URL_HERE"
```

## Create GIF from video clip

```bash
# Requires ffmpeg (brew install ffmpeg)
ffmpeg -ss 00:00:05 -t 3 -i video.mp4 \
  -vf "fps=10,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer" \
  -loop 0 /tmp/clip.gif -y -loglevel quiet
```

## Create GIF from image sequence

```bash
ffmpeg -framerate 10 -pattern_type glob -i "/tmp/frames/*.png" \
  -vf "scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" \
  -loop 0 /tmp/animation.gif -y -loglevel quiet
# Or: brew install imagemagick && convert -delay 10 -loop 0 /tmp/frames/*.png /tmp/animation.gif
```

## Workflow

1. Search Tenor first (no key needed), fall back to Giphy if no results
2. Download the best match to `/tmp/reaction.gif`
3. Send: `sendFile("/tmp/reaction.gif", channel, sessionId)`
4. Confirm: "Sent 🎉 [GIF title]"

If the channel doesn't support GIFs, share the URL instead.
