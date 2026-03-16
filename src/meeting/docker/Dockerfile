# Daemora Meeting Bot — Production Docker Image
# Matches Vexa's setup: multi-stage, Playwright + PulseAudio + Xvfb + ffmpeg + MS Edge

# --- Build Stage ---
FROM mcr.microsoft.com/playwright:v1.56.0-jammy AS base

RUN apt-get update && apt-get install -y \
    xvfb \
    ffmpeg \
    x11-utils \
    pulseaudio \
    pulseaudio-utils \
    x11-xserver-utils \
    fluxbox \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile --prod

COPY . .

# Install Playwright deps + browsers
RUN npx playwright install-deps && npx playwright install --with-deps

# MS Edge for Teams (x86_64 only)
RUN arch=$(uname -m) && if [ "$arch" = "x86_64" ] || [ "$arch" = "amd64" ]; then \
    npx playwright install msedge || true; \
    else echo "Skipping msedge on $arch"; fi

# --- Runtime Stage ---
FROM mcr.microsoft.com/playwright:v1.56.0-jammy AS runtime

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    pulseaudio \
    pulseaudio-utils \
    ffmpeg \
    fluxbox \
    x11-utils \
    x11-xserver-utils \
    xserver-xephyr \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy built app from build stage
COPY --from=base /app /app

# MS Edge in runtime (x86_64 only)
RUN arch=$(uname -m) && if [ "$arch" = "x86_64" ] || [ "$arch" = "amd64" ]; then \
    npx playwright install msedge || true; \
    else echo "Skipping msedge on $arch"; fi

# Permissions
RUN mkdir -p /root/ms-playwright && chmod -R 777 /root/ms-playwright
RUN mkdir -p /app/storage/screenshots /app/storage/recordings /app/storage/transcripts && chmod -R 777 /app/storage

# PulseAudio config — allow running as root in Docker
RUN mkdir -p /root/.config/pulse /var/run/pulse /tmp/pulse && \
    echo "autospawn = yes" > /root/.config/pulse/client.conf && \
    echo "daemon-binary = /usr/bin/pulseaudio" >> /root/.config/pulse/client.conf

# Entrypoint
COPY src/meeting/docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENV DISPLAY=:99
ENV NODE_ENV=production

EXPOSE 3456

CMD ["/app/entrypoint.sh"]
