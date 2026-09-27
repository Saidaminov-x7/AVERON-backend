# Ijarauz Backend

Backend для платформы аренды недвижимости.

## Требования
- Docker
- Docker Compose
- Node.js 20+
- pnpm

## Установка

1. Клонируйте репозиторий:
   ```bash
   git clone <repository-url>
   cd ijarauz_backend
   ```

2. Установите зависимости:
   ```bash
   pnpm install
   ```

3. Создайте файл `.env` в `apps/api/` на основе `.env.example`:
   ```bash
   cp apps/api/.env.example apps/api/.env
   ```

4. Запустите инфраструктуру:
   ```bash
   docker-compose up -d postgres redis ollama
   ```

5. Выполните миграции:
   ```bash
   pnpm prisma:migrate
   ```

6. Заполните БД тестовыми данными:
   ```bash
   pnpm prisma:seed
   ```

7. Запустите сервисы:
   ```bash
   docker-compose up -d
   ```

## Документация API
Доступна по адресу: [http://localhost:3000/docs](http://localhost:3000/docs)

## Конфигурация
Настройте переменные окружения в `apps/api/.env`:

```env
NODE_ENV=development
PORT=3000
DATABASE_URL="postgresql://postgres:postgres@postgres:5432/ijarauz?connection_limit=10&pool_timeout=20"
REDIS_URL=redis://redis:6379
JWT_SECRET=your_jwt_secret_min_32_characters_long_super_secure
REFRESH_SECRET=your_refresh_secret_min_32_characters_long_secure
CORS_ORIGINS=http://localhost:3000,http://localhost:8080
OLLAMA_BASE_URL=http://ollama:11434
AI_SERVICE_URL=http://ai-service:8000
```

### Настройка пула подключений (Railway)
Для предотвращения исчерпания пула соединений PostgreSQL на Railway в `DATABASE_URL` добавьте параметры:
`?connection_limit=10&pool_timeout=20` (или `&connection_limit=10&pool_timeout=20` если уже есть параметры).