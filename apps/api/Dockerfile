# apps/api — production image for Fly.io.
#
# Multi-stage build:
#   1. deps:  install only top-level deps (apps/api has no own package.json — uses repo root)
#   2. build: compile TypeScript via tsx-bundled path (we use --import tsx at runtime instead — see below)
#   3. run:   slim runtime
#
# Note: this app is a TypeScript entrypoint that we run via `tsx`. We don't pre-compile
# because Better Auth's plugin imports use deep paths that resolve cleanly under tsx.
# If you want a fully pre-compiled image, swap to `tsc -p tsconfig.build.json` + node dist/.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --legacy-peer-deps

FROM node:22-alpine AS runtime
WORKDIR /app

# Non-root user for the runtime layer.
RUN addgroup -S app && adduser -S app -G app

# Install tsx globally (it's a runtime dep here because we run TS directly).
RUN npm i -g tsx@^4.19.2 --ignore-scripts

# Copy installed prod deps + source.
COPY --from=deps /app/node_modules ./node_modules
COPY apps/api ./apps/api
COPY src ./src
COPY package.json ./

# Drizzle config lives in repo root referenced from apps/api.
RUN chown -R app:app /app
USER app

ENV NODE_ENV=production
ENV PORT=8090
EXPOSE 8090

# Healthcheck — Fly will use the HTTP one in fly.toml; this is for plain Docker too.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:8090/health" >/dev/null 2>&1 || exit 1

CMD ["tsx", "apps/api/src/index.ts"]
