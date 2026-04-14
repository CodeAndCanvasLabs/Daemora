# Daemora Sidecar

Python sidecar for the Daemora desktop app. Runs as a child process of the Tauri shell and exposes:

- **Desktop control** (PyAutoGUI) — mouse, keyboard, screen capture, window focus. HTTP API on `127.0.0.1:8765`.
- **Voice pipeline** (LiveKit Agents, Phase 2) — STT, TTS, VAD, wake word. Joins the local `livekit-server --dev` room as the agent participant.

Loopback only. Never binds to anything other than `127.0.0.1`.

## Dev setup

```bash
cd desktop/sidecar
uv venv
uv pip install -e .
python -m daemora_sidecar.main
```

Voice extras (Phase 2):

```bash
uv pip install -e ".[voice]"
```

## Safety rails

- **Fail-safe corner** — slam the mouse to a screen corner to abort any running sequence (PyAutoGUI built-in).
- **Rate limit** — max 20 desktop actions per minute (`DAEMORA_DESKTOP_RATE_LIMIT`).
- **Audit log** — every action logged to `~/.daemora/desktop-audit/YYYY-MM-DD.jsonl` with a pre-action screenshot in `~/.daemora/screenshots/`. 7-day retention by default.
- **Block list** — keychains, password managers, system settings panes refused by default (`DAEMORA_DESKTOP_BLOCKED_WINDOWS`).
- **Token auth** — if `DAEMORA_SIDECAR_TOKEN` is set, all endpoints require the `X-Daemora-Token` header. The Tauri shell sets this on launch so nothing else on the machine can drive the sidecar.

## Environment

| Var | Default | Purpose |
|---|---|---|
| `DAEMORA_SIDECAR_PORT` | `8765` | HTTP port |
| `DAEMORA_SIDECAR_TOKEN` | _(none)_ | Shared secret; set by Tauri shell |
| `DAEMORA_HTTP` | `http://127.0.0.1:8081` | Daemora HTTP API (for voice LLM plugin, Phase 2) |
| `DAEMORA_HOME` | `~/.daemora` | Data directory |
| `DAEMORA_DESKTOP_RATE_LIMIT` | `20` | Actions per minute |
| `DAEMORA_AUDIT_RETENTION` | `7` | Days of audit log to keep |
| `DAEMORA_DESKTOP_BLOCKED_WINDOWS` | see `config.py` | Comma-separated block list keywords |
