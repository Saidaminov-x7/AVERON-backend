#!/bin/sh
# apps/api/entrypoint.sh
# Safe runtime entrypoint: validate env and start the already-built API.
# Prisma migrations are handled by Railway preDeployCommand via pnpm prisma:deploy.

set -e

echo "▶ [AVERON Entrypoint] Starting initialization..."

if [ -z "$DATABASE_URL" ]; then
  echo "❌ [AVERON Entrypoint] FATAL: DATABASE_URL is not set!"
  echo "👉 Please add DATABASE_URL in Railway Variables (use Reference: \${{Postgres.DATABASE_URL}})"
  exit 1
fi

echo "▶ [AVERON Entrypoint] Starting API server on port ${PORT:-8080}..."

exec node apps/api/dist/server.js
