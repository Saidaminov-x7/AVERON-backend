#!/bin/sh
# apps/api/entrypoint.sh
# Запускается при старте контейнера: проверяет окружение, применяет миграции и стартует Fastify сервер

set -e

echo "▶ [AVERON Entrypoint] Starting initialization..."

# Проверка наличия обязательной переменной DATABASE_URL
if [ -z "$DATABASE_URL" ]; then
  echo "❌ [AVERON Entrypoint] FATAL: DATABASE_URL is not set!"
  echo "👉 Please add DATABASE_URL in Railway Variables (use Reference: \${{Postgres.DATABASE_URL}})"
  exit 1
fi

echo "▶ [AVERON Entrypoint] Applying Prisma database migrations (deploy)..."
cd /app && ./node_modules/.bin/prisma migrate deploy --schema=prisma/schema.prisma || {
  echo "⚠️ [AVERON Entrypoint] migrate deploy failed. Refusing destructive automatic schema changes."
  exit 1
}

echo "▶ [AVERON Entrypoint] Database schema is up to date."

echo "▶ [AVERON Entrypoint] Seeding / syncing super admin account..."
cd /app && ./node_modules/.bin/prisma db seed || true

echo "▶ [AVERON Entrypoint] Starting API server on port ${PORT:-8080}..."

exec node apps/api/dist/server.js
