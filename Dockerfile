# Daemora — single-stage image, runs `daemora start` as PID 1.
# Debian (not Alpine) so the prebuilt better-sqlite3 / @livekit/rtc-node
# native binaries load without recompilation.

FROM node:22-bookworm-slim

# Build deps for native modules (kept around: rebuild may be needed if
# the prebuilt binaries don't cover every arch). python3 + g++ are
# under 200 MB and removing them buys little when the image isn't
# pushed publicly. Slim it later if the image goes to a registry.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/usr/local/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Install in two passes so source-only edits skip the heavy install.
COPY package.json pnpm-lock.yaml ./
COPY ui/package.json ui/package-lock.json* ui/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# Data dir is bind-mounted at runtime so vault, sqlite, OAuth tokens,
# and logs persist across `docker compose down`.
ENV DAEMORA_DATA_DIR=/app/data
ENV PORT=8081
EXPOSE 8081

CMD ["node", "dist/cli/index.js", "start"]
