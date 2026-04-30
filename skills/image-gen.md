---
name: image-gen
description: Generate images using OpenAI image models (gpt-image-1, DALL-E 3, DALL-E 2). Use when the user asks to create, generate, draw, or illustrate an image, photo, logo, icon, or visual. Requires OPENAI_API_KEY.
triggers: generate image, create image, draw, illustrate, make a picture, logo, icon, artwork, visual, dall-e, image generation, render
metadata: {"daemora": {"emoji": "🎨"}}
---

## Models

| Model | Best for | Max/call | Quality |
|-------|---------|----------|---------|
| `gpt-image-1` | Highest quality, instruction-following | 10 | `high` / `medium` / `low` |
| `dall-e-3` | Artistic, stylized | 1 | `hd` / `standard` |
| `dall-e-2` | Fast, cheap drafts | 10 | `standard` |

Default: `gpt-image-1` at `high` quality.

## Sizes

```
gpt-image-1:  1024x1024 | 1536x1024 (landscape) | 1024x1536 (portrait)
dall-e-3:     1024x1024 | 1792x1024 (wide) | 1024x1792 (tall)
dall-e-2:     256x256 | 512x512 | 1024x1024
```

## Prompt tips

- Be specific: "minimalist fintech logo, dark blue, geometric sans-serif" beats "a logo"
- Specify style: photorealistic / watercolor / flat illustration / 3D render
- Specify lighting: soft studio / dramatic shadows / golden hour / neon
- Add "no text, no watermarks" if needed

## Workflow

1. Use the `generateImage` tool with the user's prompt
2. Save to `/tmp/daemora-images/image_TIMESTAMP.png`
3. Report the path
4. On macOS: `executeCommand("open /tmp/daemora-images/")` if multiple images
5. To send: `sendFile(path, channel, sessionId)`

## Errors

| Error | Fix |
|-------|-----|
| 400 content policy | Rephrase prompt, remove flagged terms |
| 401 unauthorized | Check `OPENAI_API_KEY` is valid |
| 429 rate limit | Wait 10s, retry with `n=1` |
| 503 unavailable | Retry after 30s; fall back to `dall-e-3` |
