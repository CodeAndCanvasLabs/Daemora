#!/bin/bash
# Daemora Meeting Bot — Docker Entrypoint
# Matches Vexa's production setup: Xvfb + PulseAudio + ALSA + virtual mic

export DISPLAY=:99

# Start virtual framebuffer
echo "[Daemora] Starting Xvfb..."
Xvfb :99 -screen 0 1920x1080x24 &
sleep 1

# Start window manager
fluxbox -display :99 &>/dev/null &

# PulseAudio needs to run as root in Docker — requires specific flags
echo "[Daemora] Starting PulseAudio..."
# Kill any existing instance
pulseaudio --kill 2>/dev/null || true
sleep 0.5

# Start PulseAudio in system mode (runs as root in Docker)
pulseaudio --system --disallow-exit --disallow-module-loading=0 --daemonize --log-level=info 2>/dev/null

# If system mode fails, try user mode with --allow-root
if ! pactl info &>/dev/null 2>&1; then
  echo "[Daemora] System mode failed, trying user mode..."
  pulseaudio --start --exit-idle-time=-1 --disallow-exit 2>/dev/null || true
fi

# Last resort — force start
if ! pactl info &>/dev/null 2>&1; then
  echo "[Daemora] Trying force start..."
  pulseaudio -D --exit-idle-time=-1 --log-level=error 2>/dev/null || true
fi

sleep 1

# Verify PulseAudio
if pactl info &>/dev/null 2>&1; then
  echo "[Daemora] PulseAudio daemon running"
else
  echo "[Daemora] ERROR: PulseAudio could not start"
  # Show error details
  pulseaudio --start -v 2>&1 | tail -5 || true
fi

# Create TTS sink
echo "[Daemora] Creating audio devices..."
pactl load-module module-null-sink sink_name=tts_sink sink_properties=device.description="DaemoraTTS" 2>/dev/null || true

# Create virtual mic from TTS monitor
pactl load-module module-remap-source master=tts_sink.monitor source_name=virtual_mic source_properties=device.description="DaemoraMic" 2>/dev/null || true
pactl set-default-source virtual_mic 2>/dev/null || true

# ALSA → PulseAudio routing
cat > /root/.asoundrc <<'EOF'
pcm.!default { type pulse }
ctl.!default { type pulse }
EOF

# Verify devices
echo "[Daemora] Audio device check:"
pactl list short sinks 2>/dev/null || echo "  No sinks"
pactl list short sources 2>/dev/null || echo "  No sources"

echo "[Daemora] Starting meeting bot server..."
exec node /app/src/meeting/docker/server.js "$@"
