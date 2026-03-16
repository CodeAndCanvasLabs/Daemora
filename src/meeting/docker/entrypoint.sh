#!/bin/bash
# Daemora Meeting Bot — Docker Entrypoint
# EXACT copy of Vexa's entrypoint pattern — no modifications

# Start virtual framebuffer
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99

# Start PulseAudio daemon (user mode — same as Vexa)
echo "[Entrypoint] Starting PulseAudio daemon..."
pulseaudio --start --log-target=syslog 2>/dev/null || true
sleep 1

# Create TTS sink for voice agent audio injection
echo "[Entrypoint] Creating PulseAudio TTS sink..."
pactl load-module module-null-sink sink_name=tts_sink sink_properties=device.description="TTSAudioSink" 2>/dev/null || true

# Create virtual microphone from tts_sink monitor
# Chromium discovers this as mic input for WebRTC / getUserMedia()
echo "[Entrypoint] Creating virtual microphone from TTS sink monitor..."
pactl load-module module-remap-source master=tts_sink.monitor source_name=virtual_mic source_properties=device.description="VirtualMicrophone" 2>/dev/null || true
pactl set-default-source virtual_mic 2>/dev/null || true

# Configure ALSA to route through PulseAudio
echo "[Entrypoint] Configuring ALSA to use PulseAudio..."
mkdir -p /root
cat > /root/.asoundrc <<'ALSA_EOF'
pcm.!default {
    type pulse
}
ctl.!default {
    type pulse
}
ALSA_EOF

# Run the meeting bot server
node /app/src/meeting/docker/server.js
