# macOS installer resources

The `productbuild` step picks up these files via `--resources`:

- `welcome.html` — first page of the install wizard (optional, but a
  blank one looks unprofessional). Ship a brief "Welcome to Daemora"
  page if you want to customize.
- `license.html` — license page (AGPL-3.0). The system shows the user
  Continue/Disagree buttons and refuses to install on Disagree.
- `conclusion.html` — final page after install ("Click Daemora on your
  Desktop to start — the web app will open automatically.").

If any of these files are missing, productbuild substitutes generic
text. Add them when you're ready to polish the install experience.

## Icon

`daemora.icns` is **already generated** at:

- `app-template/Daemora.app/Contents/Resources/daemora.icns`
- `app-template/Stop Daemora.app/Contents/Resources/daemora.icns`

It's rendered from [`ui/public/favicon.svg`](../../../ui/public/favicon.svg)
— the canonical Daemora mascot. To regenerate after the favicon SVG
changes:

```bash
pnpm run icons:installer
```

Script: [`scripts/build-installer-icons.mjs`](../../../scripts/build-installer-icons.mjs).
