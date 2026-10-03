# apps/api/Dockerfile
# Multi-stage production build for the AVERON backend monorepo

# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

# Устанавливаем системные зависимости для sharp и argon2
RUN apk add --no-cache python3 make g++ libc6-compat openssl

WORKDIR /app

# Устанавливаем pnpm
RUN corepack enable && corepack prepare pnpm@9 --activate

# Копируем файлы для установки зависимостей (используем кэш Docker)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/ ./packages/

# Устанавливаем ВСЕ зависимости (включая dev — нужны для сборки)
RUN pnpm install --frozen-lockfile

# Копируем prisma schema и генерируем клиент
COPY prisma/ ./prisma/
RUN pnpm --filter api prisma:generate

# Копируем остальные исходники
COPY apps/api/ ./apps/api/

# Собираем TypeScript
RUN pnpm --filter api build

# ─── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

RUN apk add --no-cache libc6-compat openssl dumb-init

# Не запускаем от root
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 apiuser

WORKDIR /app

# Устанавливаем pnpm
RUN corepack enable && corepack prepare pnpm@9 --activate

# Копируем файлы для установки prod-зависимостей
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/packages/ ./packages/

# Устанавливаем ТОЛЬКО production зависимости
RUN pnpm install --frozen-lockfile --prod

# Копируем собранные артефакты
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/prisma ./prisma

# Копируем и генерируем Prisma client в runtime (нужен для корректной работы)
COPY --from=builder /app/node_modules/.pnpm ./node_modules/.pnpm
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
# Копируем CLI Prisma (нужен entrypoint.sh для prisma migrate deploy)
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/.bin/prisma ./node_modules/.bin/prisma

# Entrypoint-скрипт: применяет миграции, затем запускает сервер
COPY apps/api/entrypoint.sh ./apps/api/entrypoint.sh
RUN chmod +x ./apps/api/entrypoint.sh

# Создаём директорию для загружаемых файлов
RUN mkdir -p /tmp/uploads && chown apiuser:nodejs /tmp/uploads

# Меняем владельца
RUN chown -R apiuser:nodejs /app

USER apiuser

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health/live').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

# dumb-init для правильного forwarding сигналов в Node.js
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["./apps/api/entrypoint.sh"]
