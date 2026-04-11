---
name: theme-switching
description: Dark/light theme toggle animations with in-place cross-fade
metadata:
  tags: theme, dark-mode, light-mode, toggle, cross-fade, ui-demo
---

A theme toggle animation should look like a real app flipping its palette: same content, same positions, only colors change. The common mistake is to render two entirely different layouts and cross-fade between them — the content appears to morph, which never happens in a real app.

## The rule

**One component, parameterized by theme. Render it twice.** Do not write separate `<DarkDashboard />` and `<LightDashboard />`.

## Palette helper

Collect every theme-dependent color into a single object keyed by theme:

```tsx
type Theme = 'dark' | 'light';

const getPalette = (theme: Theme) => {
  const dark = theme === 'dark';
  return {
    bg:          dark ? '#05070f' : 'linear-gradient(180deg,#f6f7fb,#eef1f8)',
    text:        dark ? '#ffffff' : '#0a0e1f',
    textMid:     dark ? 'rgba(255,255,255,0.62)' : 'rgba(10,14,31,0.58)',
    cardBg:      dark ? 'rgba(255,255,255,0.04)' : '#ffffff',
    cardBorder:  dark ? '1px solid rgba(255,255,255,0.1)' : '1px solid rgba(10,14,31,0.06)',
    cardShadow:  dark ? 'inset 0 1px 0 rgba(255,255,255,0.04)' : '0 20px 50px rgba(10,14,31,0.08)',
    innerBg:     dark ? 'rgba(255,255,255,0.05)' : '#f5f7fc',
    innerBorder: dark ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(10,14,31,0.05)',
  };
};
```

Put every color that differs between themes here. Anything you forget will flash wrong during the transition.

## Parameterized component

```tsx
const Dashboard = ({ theme, frame, progress }: { theme: Theme; frame: number; progress: number }) => {
  const p = getPalette(theme);
  return (
    <div style={{ background: p.bg, color: p.text /* ... */ }}>
      <h1 style={{ color: p.text }}>Analytics</h1>
      <div style={{ background: p.cardBg, border: p.cardBorder, boxShadow: p.cardShadow }}>
        {/* ... */}
      </div>
    </div>
  );
};
```

Data values (`$128.4k`, `42%`) can also vary by theme if you want the numbers to update along with the palette — the dashboard feels "alive" instead of a static snapshot being recolored. Keep the *layout* identical regardless.

## Cross-fade

Render the component twice, with opposing opacities:

```tsx
const themeFlip = interpolate(frame, [FLIP_START, FLIP_END], [0, 1], {
  easing: Easing.inOut(Easing.cubic),
  extrapolateLeft: 'clamp',
  extrapolateRight: 'clamp',
});

return (
  <>
    <div style={{ position: 'absolute', inset: 0, opacity: 1 - themeFlip }}>
      <Dashboard theme="dark" frame={frame} progress={dashProgress} />
    </div>
    <div style={{ position: 'absolute', inset: 0, opacity: themeFlip }}>
      <Dashboard theme="light" frame={frame} progress={dashProgress} />
    </div>
  </>
);
```

`Easing.inOut(Easing.cubic)` gives a natural flip. Duration of 15–25 frames feels right — faster looks glitchy, slower looks like a slow dissolve. Do **not** slide, wipe, or circular-reveal between themes; those transitions draw attention away from the content.

## Accent colors that work on both backgrounds

Bar charts, progress tracks, and highlights often use gradients. If you use white in a gradient (`linear-gradient(180deg,#00d4ff,#ffffff)`), it disappears on a white background during the light theme. Pick accents that read on both:

- **Purple** `#7c3aed`
- **Cyan** `#00d4ff`
- **Pink** `#ec4899`

All three have enough saturation to stand out on both dark navy and off-white backgrounds. Avoid pure white and near-black as accent endpoints.

## Toggle button placement

If you're also animating a toggle UI (pill + thumb), render the toggle **outside** both cross-faded layers, so it doesn't fade with the theme — it stays put while the background flips underneath it. The toggle's own appearance (track color, thumb position) is driven by the same `themeFlip` value:

```tsx
<ToggleButton flip={themeFlip} /* ... */ />
```

Inside `ToggleButton`, stack two track backgrounds with opposing opacities, and interpolate the thumb's `left` position from `0` → `1`.

## Verification

After building, render a still at the midpoint of the flip (`frame = (FLIP_START + FLIP_END) / 2`). Both dashboards should be visible at 50% opacity and every piece of text, every card, every chart should be in the **exact same position**. If anything shifts, your layouts diverged — fix the component, don't tweak the cross-fade.
