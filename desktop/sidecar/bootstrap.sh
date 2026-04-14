#!/usr/bin/env bash
# Daemora desktop sidecar bootstrap — dev-only stand-in for the Tauri installer.
# Installs everything the voice + desktop-control sidecar needs.
# On production this is replaced by the .dmg / .exe / .AppImage bundler.
#
# What this does:
#   1. brew: livekit-server (loopback SFU binary) + portaudio (mic/speaker I/O)
#   2. Python venv with desktop-control + voice extras
#
# What this does NOT do:
#   - Download local STT/TTS models. STT/TTS go through provider APIs (Deepgram,
#     ElevenLabs, Groq, OpenAI, Cartesia, ...). Pick one in the first-run wizard.
#   - The only always-local bits are Silero VAD (~1 MB, bundled inside the
#     livekit-plugins-silero wheel) and OpenWakeWord base embeddings (~5 MB,
#     lazy-loaded on first wake-word init). Both are invisible to the user.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

WITH_LOCAL=0
for arg in "$@"; do
  case "$arg" in
    --local|--offline) WITH_LOCAL=1 ;;
  esac
done

say() { printf "\033[1;36m[bootstrap]\033[0m %s\n" "$*"; }
die() { printf "\033[1;31m[bootstrap] FATAL:\033[0m %s\n" "$*" >&2; exit 1; }

OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM=macos ;;
  Linux)  PLATFORM=linux ;;
  *) die "Unsupported platform: $OS. macOS and Linux only for now." ;;
esac
say "Platform: $PLATFORM"

# ── System deps (native libraries) ─────────────────────────────────────────
install_system_deps() {
  if [[ "$PLATFORM" == macos ]]; then
    if ! command -v brew >/dev/null 2>&1; then
      die "Homebrew not found. Install from https://brew.sh first, then rerun."
    fi

    if brew list --formula livekit >/dev/null 2>&1; then
      say "livekit-server already installed"
    else
      say "Installing livekit-server…"
      brew install livekit
    fi

    if brew list --formula portaudio >/dev/null 2>&1; then
      say "portaudio already installed"
    else
      say "Installing portaudio…"
      brew install portaudio
    fi

  elif [[ "$PLATFORM" == linux ]]; then
    if ! command -v livekit-server >/dev/null 2>&1; then
      say "Installing livekit-server…"
      curl -sSL https://get.livekit.io | bash
    else
      say "livekit-server already installed"
    fi

    if command -v apt-get >/dev/null 2>&1; then
      sudo apt-get install -y portaudio19-dev libasound2-dev ffmpeg
    elif command -v dnf >/dev/null 2>&1; then
      sudo dnf install -y portaudio-devel alsa-lib-devel ffmpeg
    elif command -v pacman >/dev/null 2>&1; then
      sudo pacman -S --noconfirm portaudio alsa-lib ffmpeg
    else
      say "WARN: unknown package manager — install portaudio + ffmpeg manually."
    fi
  fi
}

# ── Python venv + voice extras ─────────────────────────────────────────────
install_python_env() {
  if ! command -v uv >/dev/null 2>&1; then
    say "Installing uv (fast Python package manager)…"
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
  fi

  if [[ ! -d .venv ]]; then
    say "Creating Python 3.11 venv…"
    uv venv --python 3.11
  else
    say "venv already exists"
  fi

  local extras="voice"
  if [[ "${WITH_LOCAL:-0}" == "1" ]]; then
    extras="voice,local"
    say "Installing desktop-control + voice + local offline extras (~400 MB)…"
  else
    say "Installing desktop-control + voice extras…"
  fi
  uv pip install -e ".[$extras]"
}

# ── Verification ───────────────────────────────────────────────────────────
verify() {
  say "Verifying install…"
  .venv/bin/python - <<'PY'
import importlib, sys
required = [
    ("fastapi", "http server"),
    ("uvicorn", "asgi"),
    ("pyautogui", "desktop control"),
    ("livekit", "realtime sdk"),
    ("livekit.agents", "pipeline framework"),
    ("livekit.plugins.silero", "VAD"),
    ("livekit.plugins.deepgram", "STT provider"),
    ("livekit.plugins.elevenlabs", "TTS provider"),
    ("openwakeword", "wake word"),
    ("sounddevice", "audio I/O"),
]
missing = []
for m, tag in required:
    try:
        importlib.import_module(m)
        print(f"  ✓ {m} ({tag})")
    except Exception as e:
        print(f"  ✗ {m}: {e}")
        missing.append(m)
if missing:
    print(f"\nMissing: {missing}", file=sys.stderr)
    sys.exit(1)
PY
  if command -v livekit-server >/dev/null 2>&1; then
    say "✓ livekit-server: $(livekit-server --version 2>&1 | head -1)"
  else
    say "✗ livekit-server not on PATH"
    exit 1
  fi
}

install_system_deps
install_python_env
verify

say "Done. Start the sidecar with: .venv/bin/python -m daemora_sidecar.main"
