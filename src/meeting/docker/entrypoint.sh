#!/bin/bash
# Daemora Meeting Bot — Docker Entrypoint
# Starts Xvfb (virtual display) + PulseAudio (virtual audio) + Meeting Bot Server

set -e

echo "[Daemora:Docker] Starting virtual display (Xvfb)..."
Xvfb :99 -screen 0 1920x1080x24 -ac -nolisten tcp &
XVFB_PID=$!
sleep 1

# Start window manager (needed for some Chromium features)
fluxbox -display :99 &>/dev/null &
sleep 0.5

echo "[Daemora:Docker] Starting PulseAudio with virtual devices..."
mkdir -p /tmp/pulse
pulseaudio --start --exit-idle-time=-1 --disallow-exit --log-level=error \
  --load="module-native-protocol-unix auth-anonymous=1 socket=/tmp/pulse/native" \
  || true
sleep 1

# Verify PulseAudio is running
if pactl info &>/dev/null; then
  echo "[Daemora:Docker] PulseAudio ready — virtual mic active"
  pactl list short sources | grep virtual_mic && echo "[Daemora:Docker] Virtual mic confirmed"
else
  echo "[Daemora:Docker] WARNING: PulseAudio failed to start"
fi

echo "[Daemora:Docker] Starting meeting bot server on port 3456..."
exec node /app/src/meeting/docker/server.js "$@"
