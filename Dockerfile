# Production image for apps/api on Fly.io.
#
# Why Debian (bookworm-slim) and not Alpine: native modules in the deps
# tree (better-sqlite3, @livekit/rtc-node) ship prebuilt binaries for glibc,
# not musl. Alpine would require recompiling them, which doubles the build
# time and image size.
#
# Why we don't pre-compile TS to JS: apps/api is plain TS that we run via
# `tsx` at runtime. Better Auth's plugin layout imports through deep paths
# that resolve cleanly under tsx; pre-compiling would force a flatter dist
# layout and more friction. The runtime hit is one-time on cold start.

# ── stage 1: install npm deps ────────────────────────────────────────
FROM node:22-bookworm-slim AS deps

WORKDIR /app

# Native module build deps. These get dropped from the final image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# --legacy-peer-deps because some sub-deps disagree on vite peers (vitest@5
# vs better-auth@1 wanting vite@7); this matches the same flag we use in dev.
RUN npm ci --legacy-peer-deps --ignore-scripts

# ── stage 2: runtime ─────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

# wget for the inline HEALTHCHECK (Fly's HTTP check uses its own probe).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*

# Non-root user for the runtime.
RUN groupadd -r app && useradd -r -g app -d /app -s /bin/false app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY apps/api ./apps/api
COPY src ./src

# tsx is in devDeps; copy it explicitly from the deps stage so we don't
# need a separate global install layer.
RUN chown -R app:app /app

USER app

ENV NODE_ENV=production
ENV PORT=8090

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:8090/health" >/dev/null 2>&1 || exit 1

# Run via npx tsx so we don't rely on shell PATH resolution for binaries.
CMD ["npx", "tsx", "apps/api/src/index.ts"]
