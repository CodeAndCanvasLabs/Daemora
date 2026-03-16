# Daemora Meeting Bot — Production Docker Image
# Based on Vexa's Docker setup: Playwright + PulseAudio + Xvfb + ffmpeg
# Chromium runs headed inside Xvfb virtual display
# PulseAudio routes TTS audio through virtual mic → WebRTC → meeting participants hear bot
#
# Auto-managed by Daemora — user never interacts with Docker directly

FROM mcr.microsoft.com/playwright:v1.56.0-jammy

# ── System dependencies ──────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    fluxbox \
    x11-utils \
    x11-xserver-utils \
    pulseaudio \
    pulseaudio-utils \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# ── PulseAudio configuration ─────────────────────────────────────────────
# Virtual sink (tts_sink) → monitor → virtual mic → Chromium picks up as mic input
RUN mkdir -p /root/.config/pulse
COPY src/meeting/docker/pulse-default.pa /root/.config/pulse/default.pa

# ── Working directory ─────────────────────────────────────────────────────
WORKDIR /app
RUN mkdir -p /app/storage/screenshots /app/storage/recordings /app/storage/transcripts

# ── Copy meeting bot code ─────────────────────────────────────────────────
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile --prod

COPY . .

# ── Environment ───────────────────────────────────────────────────────────
ENV DISPLAY=:99
ENV PULSE_SERVER=unix:/tmp/pulse/native
ENV NODE_ENV=production

# ── Entrypoint ────────────────────────────────────────────────────────────
COPY src/meeting/docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3456

ENTRYPOINT ["/entrypoint.sh"]
