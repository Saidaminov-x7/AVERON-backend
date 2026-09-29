# AVERON Backend API

Бэкенд-сервис для маркетплейса одежды и товаров из Китая **AVERON**.

## Стек технологий
- **Node.js 20+**, **TypeScript**, **Fastify**
- **Prisma ORM** + **PostgreSQL**
- **Redis** (кэширование, rate limiting, сессии)
- **Fastify JWT / Argon2** (аутентификация)
- **Zod** (валидация входных данных)

## Основные модули

- `/api/v1` (`commerceModule`):
  - Каталог товаров (`/products`, `/products/:identifier`)
  - Заказы и заявки клиентов (`POST /custom-orders`, `GET /orders/me`)
  - Импорт товаров и очередь модерации (`/admin/imports`, `/admin/products`)
  - Панель статистики и финансов (`/admin/dashboard`, `/admin/orders`)
- `/auth` (`authModule`): Регистрация, логин, refresh токенов, сессии, Google OAuth
- `/ai-chat` (`aiChatModule`): Интеграция с локальной AI моделью (Ollama) и ассистентом покупателя
- `/admin` (`adminModule`): Управление пользователями, аудит-лог, системные настройки, страницы сайта
- `/site-settings` (`siteSettingsPublicModule`): Публичные настройки витрины

## Установка и запуск

1. Клонируйте репозиторий:
   ```bash
   git clone <repository-url>
   cd AVERON_backend
   ```

2. Установите зависимости:
   ```bash
   pnpm install
   ```

3. Настройте файл окружения в `apps/api/.env`:
   ```bash
   cp apps/api/.env.example apps/api/.env
   ```

4. Запустите инфраструктуру в Docker:
   ```bash
   docker-compose up -d postgres redis
   ```

5. Примените миграции базы данных:
   ```bash
   pnpm prisma:migrate
   ```

6. Запустите сервер разработки:
   ```bash
   pnpm dev
   ```

## Документация API (Swagger)
При запущенном сервере документация Swagger UI доступна по адресу:
`http://localhost:3000/docs`