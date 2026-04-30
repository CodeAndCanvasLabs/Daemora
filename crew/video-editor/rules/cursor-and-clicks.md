---
name: cursor-and-clicks
description: Animated cursor pointer, travel paths, and click feedback for product demo videos
metadata:
  tags: cursor, pointer, click, ui-demo, interaction
---

For product-demo videos that show a user "interacting" with a UI (clicking a button, toggling a setting, hovering a card), render an SVG cursor, animate its position with `interpolate`, and add press feedback when the click lands.

## Cursor component

Use an SVG path for the arrow — CSS border-triangle hacks look amateurish. The path below is a clean macOS-style pointer with a white fill and black outline.

```tsx
const Cursor = ({
  x, y, pressed = 0, opacity = 1,
}: { x: number; y: number; pressed?: number; opacity?: number }) => (
  <div style={{
    position: 'absolute', left: x, top: y,
    width: 80, height: 104,
    transform: `translate(-6px,-4px) scale(${1 - pressed * 0.14})`,
    transformOrigin: '6px 4px',
    filter: 'drop-shadow(0 16px 32px rgba(0,0,0,0.75))',
    opacity, pointerEvents: 'none',
  }}>
    <svg width="80" height="104" viewBox="0 0 28 36" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M3 3 L3 28 L10 22 L14.5 32 L18.5 30.2 L14 20.2 L22.5 20.2 Z"
        fill="#ffffff" stroke="#000000" strokeWidth="2.2"
        strokeLinejoin="round" strokeLinecap="round"
      />
    </svg>
  </div>
);
```

The tip of the arrow is at `(3, 3)` in viewBox units. The `translate(-6px,-4px)` offset ensures `(x, y)` props refer to the **tip**, not the bounding box top-left — so you can target a button's center coordinates directly.

`transformOrigin: '6px 4px'` keeps the press scale anchored at the tip, not the middle of the arrow.

## Travel path

Drive `x` and `y` with a single `travel` progress value from `0` → `1`, eased. Use a bezier that accelerates out of the start and decelerates into the target — matches how a real hand moves a mouse.

```tsx
const travel = interpolate(frame, [START_F, END_F], [0, 1], {
  easing: Easing.bezier(0.5, 0, 0.25, 1),
  extrapolateLeft: 'clamp',
  extrapolateRight: 'clamp',
});

const x = interpolate(travel, [0, 1], [START_X, TARGET_X]);
const y = interpolate(travel, [0, 1], [START_Y, TARGET_Y]);
```

For non-linear paths (L-shapes, arcs), split `travel` into two ranges, or add a sine offset:

```tsx
const arcY = Math.sin(travel * Math.PI) * -40;   // lifts the cursor mid-travel
const y = interpolate(travel, [0, 1], [START_Y, TARGET_Y]) + arcY;
```

## Click feedback

A click is three things happening in ~8 frames: cursor scales down, the clicked element scales down, and a ring pulses outward. Drive all of them from a single `press` value with a 3-stop `interpolate`:

```tsx
const press = interpolate(frame, [CLICK_F - 2, CLICK_F, CLICK_F + 6], [0, 1, 0], {
  extrapolateLeft: 'clamp',
  extrapolateRight: 'clamp',
});
```

- **Cursor dip:** `scale(${1 - press * 0.14})` on the Cursor component (already wired above).
- **Button dip:** `scale(${1 + press * 0.05})` on the button wrapper — note the `+`, the button grows slightly before snapping back. Inverted looks wrong.
- **Ring pulse:** render a larger circle behind the click target, with opacity and border alpha tied to `press`:

```tsx
{press > 0.01 && (
  <div style={{
    position: 'absolute',
    left: thumbX - 10, top: thumbY - 10,
    width: SIZE + 20, height: SIZE + 20,
    borderRadius: '50%',
    border: `3px solid rgba(124,58,237,${press * 0.7})`,
    opacity: press,
  }} />
)}
```

## Placement relative to zoom

If you're also zooming into the click target (see [focus-zoom.md](./focus-zoom.md)), render the cursor **inside** the zoomed container. The cursor scales with the content and stays visually locked on the button during the zoom — no extra inverse-transform math.

If you need the cursor to stay at a constant size (like macOS screen zoom), render it **outside** the zoom container and compute its screen-space position as `(target_x * s + tx, target_y * s + ty)` using the same `s/tx/ty` as the zoom transform.

## Timing discipline

A realistic click sequence is:

1. Cursor fades in at its start position (8–10 frames).
2. Cursor travels to the target (30–40 frames for a full-screen diagonal).
3. Cursor hovers for 2–4 frames (feels intentional, not machine-gun).
4. Press fires (8 frames: down → hold 2 → up).
5. Effect of the click plays (e.g. theme flip, page change) over 15–25 frames.
6. Cursor holds or fades out.

Skipping the hover-pause in step 3 makes the click feel like a script, not a human.
