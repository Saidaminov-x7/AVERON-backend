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
pnpm --filter api prisma:deploy
echo "✅ [AVERON Entrypoint] Prisma migrations applied successfully."

echo "▶ [AVERON Entrypoint] Starting API server on port ${PORT:-8080}..."

exec node apps/api/dist/server.js
