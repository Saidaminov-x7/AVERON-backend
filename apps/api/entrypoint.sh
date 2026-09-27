#!/bin/sh
# apps/api/entrypoint.sh
# Запускается при старте контейнера: проверяет окружение, применяет миграции и стартует Fastify сервер

set -e

echo "▶ [Ijarauz Entrypoint] Starting initialization..."

# Проверка наличия обязательной переменной DATABASE_URL
if [ -z "$DATABASE_URL" ]; then
  echo "❌ [Ijarauz Entrypoint] FATAL: DATABASE_URL is not set!"
  echo "👉 Please add DATABASE_URL in Railway Variables (use Reference: \${{Postgres.DATABASE_URL}})"
  exit 1
fi

echo "▶ [Ijarauz Entrypoint] Applying Prisma database migrations (deploy)..."
cd /app && ./node_modules/.bin/prisma migrate deploy --schema=prisma/schema.prisma || {
  echo "⚠️ [Ijarauz Entrypoint] migrate deploy failed or has drift, running db push..."
  cd /app && ./node_modules/.bin/prisma db push --schema=prisma/schema.prisma --accept-data-loss
}

echo "▶ [Ijarauz Entrypoint] Database schema is up to date."

echo "▶ [Ijarauz Entrypoint] Seeding / syncing super admin account..."
cd /app && ./node_modules/.bin/prisma db seed || true

echo "▶ [Ijarauz Entrypoint] Starting API server on port ${PORT:-3000}..."

exec node apps/api/dist/server.js