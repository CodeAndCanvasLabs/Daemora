#!/bin/bash
# Daemora Meeting Bot — Docker Entrypoint
# Vexa-matching: Xvfb + PulseAudio (system mode) + virtual mic

export DISPLAY=:99

# Xvfb
Xvfb :99 -screen 0 1920x1080x24 &
sleep 1
fluxbox -display :99 &>/dev/null &

# PulseAudio — MUST use --system when running as root in Docker
pulseaudio --system --disallow-exit --disallow-module-loading=0 --daemonize 2>/dev/null
sleep 1

# If --system failed, the user may not be in pulse-access group
if ! pactl info &>/dev/null 2>&1; then
  # Add root to pulse groups and retry
  adduser root pulse-access 2>/dev/null || true
  adduser root pulse 2>/dev/null || true
  pulseaudio --system --disallow-exit --disallow-module-loading=0 --daemonize 2>/dev/null
  sleep 1
fi

# Verify
if ! pactl info &>/dev/null 2>&1; then
  echo "[Daemora] ERROR: PulseAudio failed"
  pulseaudio --system -v 2>&1 | tail -3
else
  echo "[Daemora] PulseAudio running"
fi

# Create TTS sink + virtual mic (Vexa pattern)
pactl load-module module-null-sink sink_name=tts_sink sink_properties=device.description="DaemoraTTS" 2>/dev/null || true
pactl load-module module-remap-source master=tts_sink.monitor source_name=virtual_mic source_properties=device.description="DaemoraMic" 2>/dev/null || true
pactl set-default-source virtual_mic 2>/dev/null || true

# ALSA → PulseAudio
cat > /root/.asoundrc <<'EOF'
pcm.!default { type pulse }
ctl.!default { type pulse }
EOF

# Verify devices
pactl list short sinks 2>/dev/null
pactl list short sources 2>/dev/null

exec node /app/src/meeting/docker/server.js "$@"
