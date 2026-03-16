#!/bin/bash
# Daemora Meeting Bot — Docker Entrypoint
# Matches Vexa's production entrypoint: Xvfb + PulseAudio + ALSA routing

# Start virtual framebuffer
echo "[Daemora] Starting Xvfb..."
Xvfb :99 -screen 0 1920x1080x24 &
sleep 1

# Start window manager (some Chromium features need it)
fluxbox -display :99 &>/dev/null &

# Start PulseAudio daemon
echo "[Daemora] Starting PulseAudio daemon..."
pulseaudio --start --log-target=syslog 2>/dev/null || true
sleep 1

# Create TTS sink — audio played here goes to tts_sink.monitor
echo "[Daemora] Creating TTS audio sink..."
pactl load-module module-null-sink sink_name=tts_sink sink_properties=device.description="DaemoraTTSSink" 2>/dev/null || true

# Create virtual microphone from TTS sink monitor
# This creates a proper capture device that Chromium discovers as mic input for WebRTC/getUserMedia
# Without this, Chromium only sees monitor sources (which it ignores for mic input)
echo "[Daemora] Creating virtual microphone from TTS sink monitor..."
pactl load-module module-remap-source master=tts_sink.monitor source_name=virtual_mic source_properties=device.description="DaemoraVirtualMic" 2>/dev/null || true
pactl set-default-source virtual_mic 2>/dev/null || true

# Configure ALSA to route through PulseAudio (Vexa pattern)
echo "[Daemora] Configuring ALSA → PulseAudio routing..."
mkdir -p /root
cat > /root/.asoundrc <<'ALSA_EOF'
pcm.!default {
    type pulse
}
ctl.!default {
    type pulse
}
ALSA_EOF

# Verify PulseAudio setup
if pactl info &>/dev/null; then
  echo "[Daemora] PulseAudio ready"
  pactl list short sinks 2>/dev/null | grep tts_sink && echo "[Daemora] TTS sink: OK"
  pactl list short sources 2>/dev/null | grep virtual_mic && echo "[Daemora] Virtual mic: OK"
else
  echo "[Daemora] WARNING: PulseAudio not running"
fi

echo "[Daemora] Starting meeting bot server on port ${PORT:-3456}..."
exec node /app/src/meeting/docker/server.js "$@"
