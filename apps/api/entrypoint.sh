#!/bin/sh
# apps/api/entrypoint.sh
# Apply committed Prisma migrations before starting the API.

set -e

echo "▶ [AVERON Entrypoint] Starting initialization..."

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
cd "$APP_ROOT"

if [ -z "$DATABASE_URL" ]; then
  echo "❌ [AVERON Entrypoint] FATAL: DATABASE_URL is not set!"
  echo "👉 Please add DATABASE_URL in Railway Variables (use Reference: \${{Postgres.DATABASE_URL}})"
  exit 1
fi

echo "▶ [AVERON Entrypoint] Applying committed Prisma migrations..."
MIGRATION_OUTPUT=$(mktemp)
trap 'rm -f "$MIGRATION_OUTPUT"' EXIT HUP INT TERM

if pnpm --filter api prisma:deploy >"$MIGRATION_OUTPUT" 2>&1; then
  cat "$MIGRATION_OUTPUT"
else
  MIGRATION_EXIT_CODE=$?
  cat "$MIGRATION_OUTPUT"

  if ! grep -q 'Error: P3005' "$MIGRATION_OUTPUT"; then
    exit "$MIGRATION_EXIT_CODE"
  fi

  echo "⚠️ [AVERON Entrypoint] Existing non-empty database has no Prisma migration history; recording the initial baseline."
  pnpm --filter api exec prisma migrate resolve \
    --applied 20260821201059_init \
    --schema=../../prisma/schema.prisma

  echo "▶ [AVERON Entrypoint] Applying migrations after the initial baseline..."
  pnpm --filter api prisma:deploy
fi

echo "✅ [AVERON Entrypoint] Prisma migrations applied successfully."

echo "▶ [AVERON Entrypoint] Starting API server on port ${PORT:-8080}..."

exec node apps/api/dist/server.js
