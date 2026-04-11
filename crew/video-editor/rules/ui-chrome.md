---
name: ui-chrome
description: Rendering realistic device frames (macbook, phone, browser) with 3D perspective and inner screens
metadata:
  tags: device-frame, macbook, phone, browser, perspective, 3d, mockup
---

Product-demo videos often need a device "mockup" — a macbook, phone, or browser window showing an app. You can do this with pure CSS using layered divs, perspective transforms, and a clipped inner screen. No assets, no 3D libraries.

## Structure

Every device frame has the same four-layer structure:

1. **Outer wrapper** — sets position, applies perspective, handles motion blur/float
2. **Body** — the physical shell (rounded rectangle with gradient fill + drop shadow)
3. **Bezel** — inset rectangle, slightly darker, gives the "screen edge" look
4. **Screen** — innermost div with `overflow: hidden`, where the actual UI content lives

```tsx
<div style={{
  position: 'absolute',
  left: '50%', top: '50%',
  transform: 'translate(-50%,-50%)',
}}>
  {/* Wrapper: perspective + motion */}
  <div style={{
    position: 'relative',
    width: 2320, height: 1380,
    transform: `perspective(2600px) rotateX(20deg) rotateZ(-25deg) translateY(${bodyY}px) scale(${bodyScale})`,
    filter: `blur(${motionBlur}px)`,
  }}>
    {/* Body */}
    <div style={{
      position: 'absolute', left: 50, top: 100,
      width: 2220, height: 1160, borderRadius: 56,
      background: 'linear-gradient(180deg,#15161b,#090b10)',
      boxShadow: '0 80px 220px rgba(0,0,0,0.78), 0 0 130px rgba(124,58,237,0.24), inset 0 1px 0 rgba(255,255,255,0.12)',
    }} />
    {/* Bezel */}
    <div style={{
      position: 'absolute', left: 120, top: 0,
      width: 2080, height: 1280, borderRadius: 40,
      background: 'linear-gradient(180deg,#21242b,#0b0d11)',
      boxShadow: '0 24px 80px rgba(0,0,0,0.5)',
    }}>
      {/* Screen */}
      <div style={{
        position: 'absolute', left: 56, top: 30,
        width: 1968, height: 1200,
        borderRadius: 30, overflow: 'hidden',
        background: '#05070f',
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.06)',
      }}>
        {/* app UI goes here */}
      </div>
    </div>
  </div>
</div>
```

## Perspective transform

`perspective(2600px) rotateX(20deg) rotateZ(-25deg)` gives the "hero angle" — a 3/4 view that shows depth without hiding the screen content. The perspective value controls foreshortening: lower numbers (`1200–1800px`) are more dramatic, higher (`3000–4000px`) are more subtle. Keep `rotateX` between `15°` and `25°` to avoid hiding too much of the screen.

The tilt also means device content needs to be **higher contrast** than flat content to remain readable — subtle text will disappear into the viewing angle.

## Motion blur on entry

When the device animates into the scene (sliding up, scaling in), add a blur filter that fades to zero as the motion settles. This sells the "camera catching up" feeling:

```tsx
const open = interpolate(frame, [10, 50], [0, 1], { easing: Easing.bezier(0.16, 1, 0.3, 1) });
const bodyY = interpolate(open, [0, 1], [150, 0]);
const bodyScale = interpolate(open, [0, 1], [0.84, 1]);
const motionBlur = interpolate(open, [0, 0.25], [30, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
```

Blur should be gone by the first quarter of the open animation (`open = 0.25`), not linear across the whole thing — otherwise the device looks hazy even when it's stopped moving.

## Idle float

Once the device is on screen, a subtle sine bob keeps it feeling alive:

```tsx
const float = Math.sin((frame / DURATION) * Math.PI * 2);
const bodyY = interpolate(open, [0, 1], [150, 0]) + float * 8;
```

`8px` amplitude is the sweet spot — any more feels like it's hovering in a breeze, any less is invisible.

## Screen reflections and gradients

The inner screen should have subtle radial gradients layered over the app content to sell glass:

```tsx
<div style={{
  position: 'absolute', inset: 0,
  background: 'radial-gradient(circle at 68% 24%, rgba(124,58,237,0.38), transparent 18%), radial-gradient(circle at 50% 50%, rgba(255,255,255,0.08), transparent 42%)',
  pointerEvents: 'none',
}} />
```

A bottom darkening gradient adds depth and visually separates the screen from the bezel:

```tsx
<div style={{
  position: 'absolute',
  left: 0, right: 0, bottom: 0, height: 160,
  background: 'linear-gradient(180deg, transparent, rgba(0,0,0,0.24))',
  pointerEvents: 'none',
}} />
```

## Device proportions

| Device | Body W×H | Screen W×H | Radius |
|---|---|---|---|
| MacBook Pro 16" | `2320×1380` | `1968×1200` | body `56`, screen `30` |
| iPad Pro 13" | `1680×1200` | `1520×1080` | body `48`, screen `24` |
| iPhone 15 Pro | `540×1080` | `480×1020` | body `74`, screen `56` |
| Browser window | `2320×1380` | `2280×1300` (under chrome) | `24` |

## Phones in a corner

For a secondary phone frame (showing a "mobile view" next to the main device), skip the 3D perspective and just drop a flat rounded-rectangle at a corner:

```tsx
<div style={{ position: 'absolute', right: 190, bottom: 140 }}>
  <div style={{
    width: 540, height: 1080, borderRadius: 74,
    background: 'linear-gradient(180deg,#17181d,#090a0f)',
    boxShadow: '0 40px 140px rgba(0,0,0,0.8), 0 0 80px rgba(124,58,237,0.18)',
  }}>
    {/* inner screen */}
  </div>
</div>
```

Mixing a perspective-tilted macbook with a flat phone reads fine and is less visually busy than two tilted frames.
