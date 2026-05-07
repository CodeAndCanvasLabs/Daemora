# Windows installer assets

`daemora.ico` is **generated from [`ui/public/favicon.svg`](../../../ui/public/favicon.svg)** —
the canonical Daemora mascot. Don't hand-edit it.

To regenerate (e.g. after the favicon SVG changes):

```bash
pnpm run icons:installer
```

That re-renders both `daemora.ico` (here) and the macOS `.icns` files.
The script lives at [`scripts/build-installer-icons.mjs`](../../../scripts/build-installer-icons.mjs).
