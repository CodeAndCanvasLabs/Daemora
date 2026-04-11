---
name: focus-zoom
description: Zoom into a specific UI element and back for product demo emphasis
metadata:
  tags: zoom, transform, product-demo, focus, emphasis
---

The "focus zoom" — zoom in on a button or region, hold while something happens, zoom back out — is the workhorse move of product demos. It draws attention to one element without cutting away from the scene.

## The math

Given:

- **Target point** `(tx, ty)` in the zoom container's local coordinates (e.g. the center of a button)
- **Zoom scale** `s` (typical: 1.6–2.0; bigger feels cartoonish)
- **Viewport** `(W, H)` — the container you're zooming inside
- **Transform origin** `top left` (do not use `center` — the math gets messier)

You want `(tx, ty)` to land at `(W/2, H/2)` after the transform. With `translate(Tx, Ty) scale(s)` applied left-to-right, a point `(px, py)` becomes `(s*px + Tx, s*py + Ty)`. So:

```
Tx = W/2 - tx * s
Ty = H/2 - ty * s
```

Constants at the top of the file:

```tsx
const VIEW_W = 1968;
const VIEW_H = 1200;
const TARGET_X = 1820;
const TARGET_Y = 112;
const ZOOM_SCALE = 1.85;
```

## The animation

Drive zoom from `0` (no zoom) → `1` (peak zoom) with a 4-stop `interpolate` that covers in → hold → out:

```tsx
const zoom = interpolate(
  frame,
  [ZOOM_IN_START, ZOOM_IN_END, ZOOM_OUT_START, ZOOM_OUT_END],
  [0, 1, 1, 0],
  {
    easing: Easing.inOut(Easing.cubic),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  },
);

const tx = interpolate(zoom, [0, 1], [0, VIEW_W / 2 - TARGET_X * ZOOM_SCALE]);
const ty = interpolate(zoom, [0, 1], [0, VIEW_H / 2 - TARGET_Y * ZOOM_SCALE]);
const scale = interpolate(zoom, [0, 1], [1, ZOOM_SCALE]);
```

Apply the transform to a wrapping div:

```tsx
<div style={{
  position: 'absolute',
  inset: 0,
  transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
  transformOrigin: 'top left',
}}>
  {/* content being zoomed */}
</div>
```

`Easing.inOut(Easing.cubic)` gives a natural accelerate-then-decelerate. Avoid linear zoom — it feels robotic.

## What to zoom

**Don't zoom the whole stage.** If your scene has 3D perspective, parallax, or a surrounding frame (laptop body, phone case, browser chrome), wrapping the entire composition in a zoom transform distorts those effects.

**Do zoom the inner content only.** Wrap just the screen's interior content (dashboard, UI, etc.) in the zoom div. The outer chrome stays rock-steady, so the zoom reads as "camera getting closer to the screen" rather than "whole scene inflating."

## Sequencing with a click

Typical focus-zoom around a click lasts ~2 seconds and has five phases:

| Phase | Frames | What happens |
|---|---|---|
| Travel | 30–40 | Cursor moves toward target while zoom is still 0 |
| Zoom in | 18–20 | Cursor arrives; zoom goes 0 → 1 |
| Hold | 6–10 | Click fires, ring pulses, effect starts |
| Hold + effect | 15–20 | Whatever the click does plays out at peak zoom |
| Zoom out | 18–20 | Zoom goes 1 → 0 while the post-click state settles |

Overlap zoom-in with the tail of the cursor travel so both finish together — otherwise the cursor visibly "arrives and then waits" for the zoom.

## Overflow and clipping

When the content is zoomed and translated, parts of it fall outside the viewport. Make sure the zoom's parent has `overflow: hidden` — otherwise clipped content spills over other scene elements.

```tsx
<div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
  <div style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})`, transformOrigin: 'top left' }}>
    {/* ... */}
  </div>
</div>
```

## Picking `ZOOM_SCALE`

- `1.3–1.5` — gentle emphasis, good for highlighting a region of a dashboard
- `1.6–2.0` — clear focus on a single button or control (the sweet spot)
- `2.5+` — dramatic, starts to feel like a jump-cut; content pixelation becomes visible on low-res renders
