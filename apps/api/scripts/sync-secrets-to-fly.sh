#!/usr/bin/env bash
#
# Pushes the SECRET subset of apps/api/.env.local to Fly secrets.
# Skips local-only values (PUBLIC_APP_URL, PORT, NODE_ENV, etc.) — those
# come from fly.toml in prod.
#
# Usage:   ./apps/api/scripts/sync-secrets-to-fly.sh
# App:     deamora-specialized-saas (override with APP env var)
#
# Reads keys, never echoes their values. Safe to run multiple times —
# `flyctl secrets set` upserts.

set -euo pipefail

ENV_FILE="${ENV_FILE:-apps/api/.env.local}"
APP="${APP:-deamora-specialized-saas}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found"
  exit 1
fi

if ! command -v flyctl >/dev/null 2>&1; then
  echo "error: flyctl not on PATH — install with 'brew install flyctl'"
  exit 1
fi

# Whitelist of keys to push to Fly. Everything else stays local-only.
SECRET_KEYS=(
  DATABASE_URL
  JWT_SIGNING_KEY
  SESSION_COOKIE_SECRET
  MASTER_KEK
  CONTROL_PLANE_ADMIN_TOKEN
  RESEND_API_KEY
  CONTRA_PAYMENT_LINK_PRO
  CONTRA_PAYMENT_LINK_LITE
)

# Build the `flyctl secrets set KEY=VALUE ...` invocation.
args=()
missing=()
for key in "${SECRET_KEYS[@]}"; do
  # Read the value from .env.local — strip surrounding quotes if present.
  value="$(awk -F= -v k="$key" '$1 == k {
    sub(/^[^=]*=/, "");
    gsub(/^"|"$/, "");
    print
    exit
  }' "$ENV_FILE")"

  if [[ -z "$value" ]]; then
    missing+=("$key")
    continue
  fi

  args+=("$key=$value")
  echo "  + $key (set)"
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo ""
  echo "warning: skipped (empty in $ENV_FILE): ${missing[*]}"
  echo "         if these are required, set them in .env.local first."
fi

if [[ ${#args[@]} -eq 0 ]]; then
  echo "nothing to push — all secret keys are empty in $ENV_FILE"
  exit 1
fi

echo ""
echo "pushing ${#args[@]} secret(s) to Fly app: $APP"
flyctl secrets set --app "$APP" "${args[@]}"
echo ""
echo "done. Next: flyctl deploy --app $APP"
