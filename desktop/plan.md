# Daemora Desktop — Full Build Plan

Voice-first desktop app that runs Daemora as the agent brain, talks to you through a real-time voice pipeline, and can see / click / type on your screen. Cross-platform (macOS, Windows, Linux today; iOS / Android later) via a single Tauri 2 shell that reuses the existing web UI.

---

## 0. Goals & non-goals

**Goals**
- Native tray + floating window app, not a terminal.
- Push-to-talk **and** wake-word voice. Sub-400 ms perceived first-audio latency from end-of-speech.
- Full desktop control: mouse, keyboard, screen capture, vision-based element finding.
- Zero mandatory paid SaaS. Every required piece has a free/self-hosted path. Premium providers (OpenAI, ElevenLabs, Deepgram, Cartesia) are optional.
- One install ships everything: the Tauri shell, the Daemora Node runtime, the Python sidecar. User double-clicks once.
- Reuse the Daemora web UI (`daemora-ui/`) verbatim as the webview — no second frontend codebase.
- Phone support later (Tauri 2 mobile), without a rewrite.

**Non-goals**
- No cloud dependency. The desktop app must work fully offline with local models (Ollama + faster-whisper + Piper) if the user chooses.
- No rewrite of Daemora. Daemora stays untouched — the desktop is a shell on top.
- No custom voice pipeline from scratch. We use LiveKit Agents (Apache-2.0) as the framework.

---

## 1. Architecture at a glance

```
┌─────────────────────────────────── Desktop App (one install) ─────────────────────────────────────┐
│                                                                                                    │
│  ┌────────────────────┐  ┌───────────────────────┐  ┌────────────────────────┐  ┌──────────────┐  │
│  │  Tauri 2 shell     │  │  Daemora (Node)       │  │  Sidecar (Python)      │  │ livekit-     │  │
│  │  Rust + webview    │  │  spawned child        │  │  spawned child         │  │ server --dev │  │
│  │                    │  │                       │  │                        │  │ spawned child│  │
│  │  - tray icon       │  │  - AgentLoop          │  │  - LiveKit Agent       │  │              │  │
│  │  - unified window  │◄─┤  - tools / crew       │◄─┤  - STT / VAD / TTS     │──┤  127.0.0.1   │  │
│  │    (chat + voice   │  │  - channels           │  │  - PyAutoGUI actions   │  │  :7880       │  │
│  │    in same screen) │  │  - vault / SQLite     │  │  - wake-word (user     │  │  loopback    │  │
│  │  - global hotkey   │  │  - /api/chat SSE      │  │    configurable)       │  │  only        │  │
│  │  - webview =       │  │  - /api/setup/*       │  │  - joins local LK room │  │              │  │
│  │    daemora-ui/dist │  │  - /api/vault/*       │  │    as "agent"          │  │  devkey/     │  │
│  │  - joins local LK  │  │  - /api/settings      │  │                        │  │  secret      │  │
│  │    room as "user"  │  │  - /api/voices/*      │  │                        │  │  baked in    │  │
│  │    via @livekit/   │  │                       │  │                        │  │              │  │
│  │    client          │  │                       │  │                        │  │              │  │
│  └────────────────────┘  └───────────────────────┘  └────────────────────────┘  └──────────────┘  │
│         ▲                                                                                          │
│         │ mic / speaker (WebRTC via loopback LK server)                                           │
│         ▼                                                                                          │
│    user speaks / clicks / types / hears                                                            │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Four processes, one installer.** Tauri is the parent. On launch it spawns: (1) Daemora node runtime, (2) Python sidecar, (3) `livekit-server --dev` on loopback only. All three are killed on quit. Nothing ever leaves `127.0.0.1`.

**Why a local LiveKit server instead of terminal mode?** The self-host docs (`livekit-server --dev`) give us a full SFU bound to `127.0.0.1:7880` with baked-in dev credentials (`devkey`/`secret`). Loopback only, no firewall hole, no account. We get LiveKit's real pipeline — turn detection, interruption, barge-in, proper WebRTC audio tracks — instead of fighting an unstable terminal mode. The `@livekit/client` React SDK drives the voice visualizations directly from live audio tracks. Binary is ~50 MB, bundled in the installer.

**Why not merge them?** Different runtimes, different concerns. Tauri = native shell, reuses webview. Daemora = agent brain, already exists. Sidecar = Python-only libs (PyAutoGUI, faster-whisper, LiveKit Agents plugins). LiveKit server = standalone Go binary. Cleaner to keep them separate and talk over `127.0.0.1`.

---

## 2. Voice pipeline

### 2.1 Framework: LiveKit Agents + local `livekit-server --dev`

LiveKit Agents is a Python framework (Apache-2.0) for building real-time voice agents. Handles: VAD, interruption, turn detection, plugin-based STT/TTS/LLM, barge-in, noise suppression. Production-grade.

**Deployment mode: local self-hosted server on loopback.**

Per the LiveKit self-hosting docs (`https://docs.livekit.io/transport/self-hosting/local/`):
- Install: plain binary (`brew install livekit`, `curl -sSL https://get.livekit.io | bash`, or Windows release).
- Run: `livekit-server --dev` → binds to `127.0.0.1:7880` by default.
- **Dev credentials are baked into the binary:** API key `devkey`, secret `secret`. No account, no registration, no cert setup.
- Single-home SFU, ~3,000 participants per room (far more than we need).

We bundle the `livekit-server` binary (~50 MB per platform) inside the installer and launch it as a child of Tauri. Because it binds to `127.0.0.1` only, there is no firewall exposure — the hardcoded dev credentials are safe.

**Participants in the room:**
1. **Sidecar (Python)** joins as the "agent" participant via `livekit-agents` SDK. It runs the full pipeline plugins (VAD / STT / LLM / TTS).
2. **Tauri webview (daemora-ui)** joins as the "user" participant via `@livekit/client` (JS SDK). It captures mic, publishes the audio track, subscribes to the agent's audio track, plays it, and drives the unified UI's voice visualizations from real live audio.

Mic capture lives in the webview (not the sidecar) because `@livekit/client` has first-class React hooks and lets us drive waveforms, speaking indicators, and barge-in UI from real audio tracks. No fake events.

### 2.2 Pipeline stages

```
mic  →  VAD (Silero)  →  STT  →  LLM (Daemora)  →  TTS  →  speaker
                                     │
                                     └─ barge-in: user interrupts → pipeline cancels in-flight TTS
```

| Stage | Default (free, local) | Opt-in premium |
|---|---|---|
| VAD | Silero VAD (bundled, ~20 MB) | — |
| STT | faster-whisper `small.en` (GPU or CPU, bundled) | Deepgram, OpenAI Whisper API |
| LLM | Daemora `/api/chat` SSE stream | same (Daemora routes to whatever model) |
| TTS | Piper (bundled, ~30 MB per voice) | ElevenLabs, Cartesia Sonic, OpenAI |
| Wake word | OpenWakeWord (Apache-2.0, bundled) | Porcupine (free personal tier) |

Every row has a free bundled default. The app works offline out of the box.

### 2.3 Daemora as the LLM

LiveKit Agents lets you plug any LLM by implementing a tiny `LLM` interface: given a conversation, stream tokens. We write a custom plugin (~50 lines of Python) that POSTs to Daemora's existing `/api/chat` SSE endpoint and yields each `text:delta` as a token.

This means **Daemora is unmodified**. Voice looks to Daemora like another HTTP client. The agent runs its full pipeline: tools, crew, memory, MCP. Tool-call names stream back (we just wired this — `tool:before` events) and the sidecar can optionally speak "checking Gmail…" style audio cues during tool calls to kill dead air.

### 2.4 Latency budget

| Hop | Time |
|---|---|
| End-of-speech → VAD fires | ~50 ms |
| STT (local faster-whisper, partial) | ~150 ms |
| Sidecar → Daemora HTTP | ~1 ms (localhost) |
| Daemora model first token (Anthropic streaming) | ~200–400 ms |
| Daemora → sidecar first text:delta | ~1 ms |
| TTS first audio chunk (Piper or Cartesia) | ~80–150 ms |
| **Perceived first-audio** | **~350–600 ms** |

Tool calls add dead air. Mitigations:
1. System prompt nudge in voice mode: "speak a short acknowledgement before the first tool call".
2. Sidecar watches `tool:before` events over SSE and plays short audio cues ("one sec", soft tick) when a tool fires and the agent goes silent for >700 ms.

### 2.5 Input modes

- **Push-to-talk** — global hotkey (default `F13` or `Right Option`). Registered from Tauri via `tauri-plugin-global-shortcut`. Hold to record, release to end turn. Best for deliberate use.
- **Wake word** — OpenWakeWord always-listening loop in the sidecar, CPU-cheap (<2%). On detection, hand off to VAD-driven turn. Default wake phrase: "Hey Daemora".
- **Manual button** — mic button in the floating window for users who don't want hotkeys.

All three modes route into the same pipeline. Exactly one is active at a time, chosen in settings.

---

## 3. Desktop control

### 3.1 Why Python, not Node

We originally considered `@nut-tree/nut-js` (Node native GUI automation). It moved to a paid model in 2024 ($20–$75/mo, plugins $35 each). The community fork exists but requires building from source and is unmaintained. **PyAutoGUI is BSD, free, maintained, and covers everything we need.** The sidecar is already Python for LiveKit Agents, so reusing it for desktop control is zero extra runtime.

### 3.2 Tools exposed to Daemora

These live as a new crew in Daemora: `crew/desktop-control/`. The crew tools are thin wrappers that HTTP POST to the sidecar's `/desktop/*` endpoints. The sidecar handles the actual PyAutoGUI calls.

| Tool | Sidecar endpoint | Notes |
|---|---|---|
| `mouseClick(x, y, button)` | POST `/desktop/click` | Supports left/right/double |
| `mouseMove(x, y)` | POST `/desktop/move` | |
| `typeText(text)` | POST `/desktop/type` | |
| `pressKey(key, modifiers)` | POST `/desktop/keypress` | Cross-platform key names |
| `keyCombo(keys)` | POST `/desktop/combo` | e.g. Cmd+C |
| `screenshot(region?)` | POST `/desktop/screenshot` | Returns PNG path |
| `findElement(description)` | POST `/desktop/find` | Vision → coordinates (see below) |
| `scroll(dx, dy)` | POST `/desktop/scroll` | |
| `listWindows()` | POST `/desktop/windows` | Active app list |
| `focusWindow(name)` | POST `/desktop/focus` | |

`findElement` is the smart one: the sidecar takes a screenshot, passes it to Daemora's existing `imageAnalysis` tool (Claude vision), gets back bounding-box coordinates, returns them. The agent then calls `mouseClick` with those coordinates. This is how the agent actually operates the GUI without brittle image-template matching.

### 3.3 Safety rails (critical)

PyAutoGUI can brick a running session if misused. Non-negotiables:

- **Fail-safe corner** — PyAutoGUI's built-in: slam the mouse to a screen corner to kill any running sequence. On by default.
- **Daemora permission gate** — every desktop tool is gated by `PermissionGuard` ("full auto" / "ask per tool" / "ask per session"). Default is "ask per session" — agent has to get consent once, per desktop-control use, per session.
- **Rate limit** — max 20 desktop actions per minute. Prevents runaway loops (e.g. agent clicking at the same spot in a loop).
- **Per-action screenshot log** — every click/type/key produces a timestamped screenshot into `~/.daemora/desktop-audit/`. One week retention. The user can replay exactly what the agent did to their machine.
- **Block list** — system pref panes (System Settings on macOS, Control Panel on Windows), keychain / vault apps, password managers, and anything the user adds to `desktop.blockedWindows` in config. Agent gets an error if it tries to focus one.
- **Kill switch** — global hotkey `Ctrl+Shift+Esc` hard-stops the current task and cancels any pending desktop action. Registered by Tauri alongside push-to-talk.

---

## 4. Tauri shell (the app itself)

### 4.1 Why Tauri 2

- **Cross-platform today**: macOS, Windows, Linux from one codebase (vs. Electron's same coverage but 10× bundle size).
- **Mobile later**: Tauri 2 (stable 2024) adds iOS + Android targets. We write the webview once, the Rust shell gets mobile adapters for free.
- **Small**: ~10 MB installer vs. Electron's ~100 MB. Matters when we're also bundling Python + models.
- **Webview reuses our React UI**: `daemora-ui/dist` drops in as the Tauri frontend unchanged. Zero second codebase.
- **Rust APIs are what we need**: tray icon, global shortcuts, child process management, auto-updater, notifications. All first-party plugins.

### 4.2 Windows & interactions

| Window | Always on top | Always visible | Purpose |
|---|---|---|---|
| Tray icon | — | yes | Daemora logo, click toggles unified window, right-click shows menu (Settings, Quit, Voice on/off, Wake word on/off) |
| Unified chat + voice | pin optional | toggle | **Single 480×720 window** with chat, tool-call timeline, AND live voice visualizer stacked together. Draggable, collapsible, pinnable. Main interaction surface. |
| Settings | no | on-demand | Full `daemora-ui` in a 1024×720 window. Full parity with `daemora setup` CLI: models, crew, skills, channels, vault, voice, wake words, hotkeys, MCP, cost limits, permission tier. |

**Unified window layout (top to bottom):**
```
┌──────────────────────────────────────────┐
│  [logo] Daemora            ◎ voice ⚙ ✕  │  ← header: voice toggle, settings, close
├──────────────────────────────────────────┤
│    chat messages scroll area             │
│    ...                                   │  ← existing Chat.tsx
├──────────────────────────────────────────┤
│  🔧 readFile · package.json       42ms  │
│  🔧 grep · "streamText"          120ms  │  ← live tool-call timeline (already wired)
│  ⟳  generateImage · "cyan logo..."      │
├──────────────────────────────────────────┤
│  ▁▃▅▇▇▅▃▁ waveform  ● speaking     🎙   │  ← voice strip — only visible when voice on
├──────────────────────────────────────────┤
│  [ text input .............. ] [ ↑ ]    │  ← text input always available
└──────────────────────────────────────────┘
```

One window. Chat and voice are never separated. The waveform and speaking indicator are driven by real audio tracks from `@livekit/client`, not fake events. Voice strip collapses to 0 height when voice is off. Text input stays always available — hybrid interaction (type while listening, speak while reading) works out of the box.

### 4.3 Global hotkeys

Registered via `tauri-plugin-global-shortcut`:

| Hotkey (default) | Action |
|---|---|
| `Cmd/Ctrl+Shift+D` | Toggle floating chat |
| `Cmd/Ctrl+Shift+V` | Toggle voice mode (push-to-talk) |
| `F13` (hold) | Push-to-talk hold |
| `Ctrl+Shift+Esc` | Kill current task + desktop actions |
| `Cmd/Ctrl+Shift+S` | Screenshot + ask Daemora |

All user-remappable in settings.

### 4.4 Child process lifecycle

Tauri's `tauri-plugin-shell` + a small Rust supervisor module:

```
App launch:
  1. Start Daemora (node src/cli.js start --port auto)  → capture port from stdout
  2. Start Python sidecar (python sidecar/main.py --daemora-port <port>)
  3. Once both healthy, load the webview pointing at http://localhost:<port>/
  4. On crash: exponential backoff, restart (max 5 tries, then show error UI)

App quit:
  1. Send SIGTERM to sidecar, wait 2s, SIGKILL
  2. Send SIGTERM to Daemora, wait 5s, SIGKILL (Daemora has graceful shutdown)
  3. Tauri exits
```

Daemora stays headless by default (no tray, no browser) when launched as a Tauri child — a new CLI flag `--embedded` suppresses its own tray/browser opening.

### 4.5 First-run onboarding

On first launch, Tauri checks for `~/.daemora/config.json`. If absent:
1. Show a native onboarding window (5 steps, same wizard as `daemora setup`).
2. Step 1: pick default LLM provider (Anthropic / OpenAI / Google / Ollama). Keys stored in the existing Daemora vault.
3. Step 2: pick voice stack — "Free local" (bundled Piper + faster-whisper + OpenWakeWord) or "Premium" (ElevenLabs + Deepgram keys).
4. Step 3: grant OS permissions — Mic, Accessibility (for PyAutoGUI), Screen Recording (for screenshots). Tauri deep-links to the right system pref page on each OS.
5. Step 4: pick wake word + hotkeys.
6. Step 5: done → floating chat opens.

---

## 5. UI / visual design

Reuse the existing `daemora-ui` color scheme: slate-950 background, `#00d9ff` cyan primary, `#4ECDC4` teal secondary, mono fonts, subtle grain overlay, animated glow gradients. Nothing new to design system-wise — we inherit it.

### 5.1 Floating chat window
- 420×640, rounded, glassmorphic (Tauri supports `decorations: false` + CSS `backdrop-filter`).
- Draggable from anywhere (`data-tauri-drag-region`).
- Pin / unpin button (always-on-top toggle).
- Collapses to a thin 420×48 "pill" showing the last assistant message + a mic button.
- Tool-call timeline (we just built it in `Chat.tsx`) streams inside this window.

### 5.2 Voice HUD
- 200×80 pill at the top-center of the primary screen.
- Live waveform (canvas, mic input) while user speaks.
- Swap to a 3-dot thinking pulse while Daemora processes.
- Swap to a speaking bar while TTS plays.
- Click to mute, double-click to dismiss.
- Animations tied to actual audio events from the sidecar over WebSocket.

### 5.3 Settings window
- Full `daemora-ui` settings, already built. Add three new sections:
  - **Voice** — wake word, hotkey, STT provider, TTS provider, voice HUD on/off.
  - **Desktop** — permission mode, rate limit, block list, audit log viewer.
  - **Hotkeys** — all global shortcuts, rebind UI.

### 5.4 Logo + branding
Existing Daemora logo (`daemora-ui/src/app/components/ui/Logo.tsx`) renders in the tray icon (monochrome variants per OS), the floating window header, and the voice HUD. Animations: slow bounce in the chat header (already done), pulse ring in the voice HUD when speaking.

---

## 6. Packaging & distribution

### 6.1 What ships in the installer

```
Daemora Desktop.app (macOS) / Daemora Desktop.exe (Windows) / .AppImage (Linux)
├── Tauri binary (Rust)
├── daemora-ui/dist/                   ← embedded via Tauri
├── daemora-runtime/                    ← full Daemora Node source + node_modules (minified)
│   └── node  (bundled Node 20 runtime via `@yao-pkg/pkg` or `sea`)
├── sidecar/                            ← Python sidecar
│   ├── python/                         ← embedded Python 3.11 (python-build-standalone)
│   ├── main.py
│   ├── requirements.txt (pre-installed into ./python)
│   └── models/                         ← bundled model files (~500 MB)
│       ├── silero_vad.onnx             (~20 MB)
│       ├── faster-whisper-small.en/    (~240 MB)
│       ├── piper/en_US-amy-medium.onnx (~60 MB)
│       └── openwakeword/hey_daemora/   (~5 MB)
└── resources/
    └── icons, sounds, etc.
```

Total installer: **~650 MB**. Large because of bundled models. Optional: "lite installer" (~80 MB) that downloads models on first run.

### 6.2 Build pipeline

- `pnpm --filter daemora-ui build` → `daemora-ui/dist/`
- `pnpm run desktop:bundle-daemora` → copies Daemora source, prunes dev deps, bundles Node runtime
- `python scripts/bundle_sidecar.py` → freezes Python env with `pyoxidizer` or `python-build-standalone` + `uv`
- `cargo tauri build` → produces platform-native installer (`.dmg`, `.msi`, `.AppImage`, `.deb`)

GitHub Actions matrix: macOS (arm64 + x64), Windows x64, Linux x64. Releases go to `github.com/CodeAndCanvasLabs/Daemora/releases` alongside the npm package.

### 6.3 Auto-update

`tauri-plugin-updater` with signed updates. Update channel in settings: `stable` / `beta`. The app checks on launch + every 12 h, prompts the user before applying. Never auto-updates silently.

### 6.4 Code signing

- macOS: Apple Developer ID (Umar's account). Notarization via `notarytool`. Required for clean install.
- Windows: Authenticode cert (EV preferred, standard acceptable with SmartScreen warnings the first week).
- Linux: GPG-signed AppImage, flatpak later.

Non-negotiable for macOS — unsigned apps are blocked by Gatekeeper on modern macOS. Budget for the certs up front.

---

## 7. Skill marketplace parity

Out of scope for the initial desktop build but included here so we don't forget:

- Daemora's skill loader already supports both `triggers:` (keyword) and `description:` (Claude-style) in frontmatter (to verify — if not yet, add it during Phase 5).
- Add CLI: `daemora skills install <name>` pulls from the community index on GitHub, drops into `~/.daemora/skills/`.
- Expose in the settings window: Skills tab → Browse → Install.
- This makes any skill from the Anthropic skills repo or ClawHub installable in Daemora Desktop with one click.

---

## 8. Build order (6 phases, ~6–8 weeks)

Each phase ships something usable. No big-bang reveal at the end.

### Phase 1 — Sidecar + desktop control (week 1–2)

- Set up `sidecar/` Python project with `uv`.
- HTTP server (FastAPI) with `/desktop/*` endpoints wrapping PyAutoGUI.
- Safety rails: rate limit, audit log, block list, fail-safe.
- New Daemora crew `crew/desktop-control/` with tools that HTTP POST to the sidecar.
- PermissionGuard integration: desktop tools ask per session.
- **Test**: run Daemora from terminal as usual, sidecar as a separate process, ask agent "take a screenshot and tell me what's open" → "open the Finder". Confirm audit log, rate limit, block list all work.

### Phase 2 — Voice pipeline (week 2–3)

- Add LiveKit Agents to the sidecar (`livekit-agents` + `livekit-plugins-silero` + `livekit-plugins-openai` optional).
- Bundle faster-whisper, Piper, OpenWakeWord, Silero.
- Write the custom LLM plugin that streams from Daemora's `/api/chat` SSE.
- Wire the voice HUD events over WebSocket to the sidecar (stub a terminal UI for Phase 2; real HUD comes in Phase 4).
- Push-to-talk via `pynput` global hotkey inside the sidecar for now.
- **Test**: run sidecar standalone, push hotkey, speak "what's in my downloads folder", hear response. Works offline with local models.

### Phase 3 — Tauri shell MVP (week 3–4)

- `cargo create-tauri-app daemora-desktop` in `desktop/app/`.
- Tray icon + floating window loading `daemora-ui/dist`.
- Child process supervisor (Rust module) that spawns Daemora + sidecar at launch and kills them on quit.
- Global hotkeys via `tauri-plugin-global-shortcut`.
- Window drag, collapse to pill, pin.
- **Test**: double-click the dev build → tray appears → click opens floating chat → type a message → works end-to-end.

### Phase 4 — Voice HUD + wake word integration (week 4–5)

- Replace the terminal UI with the Tauri voice HUD window.
- WebSocket from sidecar → HUD for live audio events (waveform, thinking, speaking).
- Wake word enabled by default, user can disable in settings.
- Audio cues during tool calls (tie into `tool:before` SSE we just wired).
- **Test**: say "Hey Daemora, open the Chrome tab about React hooks" → wake word fires → HUD appears → STT → Daemora → desktop control crew → Chrome opens.

### Phase 5 — Onboarding, settings, polish (week 5–6)

- First-run wizard (5 steps).
- OS permission deep links (mic / accessibility / screen recording).
- Settings: Voice tab, Desktop tab, Hotkeys tab.
- Skill marketplace install button (if skill loader parity is done; otherwise defer).
- Animations: logo pulse in HUD, gradient glows, smooth transitions.
- Accessibility: keyboard nav, screen reader labels, high-contrast mode.
- **Test**: fresh install on a clean macOS VM → onboarding flow → voice works → desktop control works → no terminal visible at any point.

### Phase 6 — Packaging, signing, release (week 6–8)

- GitHub Actions build matrix.
- Model bundling / lite installer switch.
- Code signing (macOS + Windows).
- Auto-updater (stable + beta channels).
- Landing page section on `daemora.com` for the desktop download.
- Beta release → collect feedback → 1.0.
- **Test**: fresh installs on macOS arm64 / macOS x64 / Windows 11 / Ubuntu 22.04 all work without a terminal.

---

## 9. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Bundling Python + Node + models pushes installer past 1 GB | medium | medium | Lite installer path, downloads models on first run |
| LiveKit terminal-mode pipeline is less mature than room-mode | low | high | Fallback: spin up a local LiveKit server as a child process (still free, Apache-2.0), join a local room |
| Wake word false positives in noisy rooms | medium | low | OpenWakeWord confidence threshold in settings; push-to-talk always available as fallback |
| PyAutoGUI + screen scaling issues on high-DPI / multi-monitor | high | medium | Normalize coordinates via screen info from sidecar; test on multi-monitor early |
| macOS accessibility permissions friction | high | medium | Explicit onboarding step with deep link + screenshot guide |
| faster-whisper CPU-only latency too high on low-end machines | medium | medium | Pre-flight benchmark on first run; warn user, suggest Deepgram fallback |
| Tauri mobile targets still rough around the edges | medium | low (future) | Mobile is post-1.0; desktop works regardless |
| Tool-call dead air feels broken in voice | high | medium | System prompt nudge + audio cues + sub-agent background execution for long tools |
| Desktop control misclicks on the wrong window | high | high | Screenshot audit log + kill switch + per-action consent until trust is built |
| Model file downloads blocked by corporate firewalls | low | medium | Offline installer with all models bundled |

---

## 10. Open decisions (ping me)

1. **Wake word phrase** — "Hey Daemora" (default)? Customizable per-user?
2. **Default voice** — which Piper voice ships as the default? Male / female / neutral? User picks on first run?
3. **Bundled vs lite installer** — ship the 650 MB version as default, or lite + download on first run?
4. **Desktop control default permission mode** — "ask per session" (safer) or "full auto" (trust by default)?
5. **Telemetry** — opt-in crash reporting (Sentry self-hosted or Telemetry.io)? None at all?
6. **Paid signing certs** — Apple Developer Program ($99/yr) + Windows EV cert (~$300/yr) — ship as unsigned beta first, or wait for certs?
7. **Mobile priority** — iOS first, Android first, or both after 1.0?
8. **Voice HUD visibility** — always on while voice mode is on, or only during active turn?
9. **Offline vs online defaults** — free local stack (Piper/Whisper) by default, or premium (ElevenLabs/Deepgram) if keys are in the vault?
10. **Sidecar crash recovery** — auto-restart silently, or surface to user with a toast?

---

## 11. What we are NOT building

Explicitly off-scope so nobody wastes time:

- **A new agent runtime** — Daemora is the agent. The desktop is a shell.
- **A second UI codebase** — the webview IS `daemora-ui`. No duplication.
- **A LiveKit cloud dependency** — terminal mode only. Local LiveKit server is the fallback, still free.
- **A custom STT/TTS from scratch** — bundled open-source models as the default, premium providers as plug-ins.
- **A keyboard/mouse macro recorder** — the agent IS the automation layer. No record-and-replay.
- **A web version of the desktop app** — if you want web, use `daemora-ui` directly. The desktop is specifically for local hardware access (mic, screen, mouse).
- **Mobile in Phase 1–6** — Tauri 2 supports it, we'll get to it after desktop 1.0.

---

## 12. Why this plan is the right call

- **Zero Daemora changes in Phase 1** — desktop control is a new crew, nothing else touches the core. We can ship Phase 1 as a separate `daemora-desktop-control` package even before the Tauri shell exists.
- **Daemora is unmodified through Phase 2** — the voice pipeline talks to `/api/chat` like any other channel. If voice breaks, Daemora still works from the browser.
- **Every phase ships something useful** — Phase 1: desktop control from terminal. Phase 2: voice from terminal. Phase 3: tray app. Phase 4: voice tray app. Phase 5: polished. Phase 6: distributed. No big bang.
- **One install, one experience** — Tauri bundles everything. User double-clicks. No npm, no pip, no terminal.
- **Free by default, premium by choice** — every required piece has a bundled free path. Paid providers are additive.
- **Cross-platform today, mobile tomorrow** — Tauri 2 is the one-codebase bet that pays off twice.

Ship it.
