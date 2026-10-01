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

## Контракт каталога и production migrations

- Публичный `GET /api/v1/categories` возвращает только активные категории. Поле
  `active` — единственное каноническое поле состояния категории; API не использует
  alias `isActive`.
- `GET /api/v1/products?category=<slug>` фильтрует каталог на сервере до
  пагинации. Название категории в JSON хранит локали `ru`, `uz`, `en`.
- Ручной товар может не иметь `sourceUrl`, `originalPriceCny` и `exchangeRate`.
  В схеме Prisma эти поля nullable; для production применяйте только
  `pnpm prisma:deploy` (`prisma migrate deploy`). Не используйте `db push` или
  команды reset.

Для production admin TOTP задайте `TOTP_ENCRYPTION_KEY` только в backend secret
store. Это случайный ключ ровно из 64 hex-символов (32 байта), например
сгенерированный `openssl rand -hex 32`. Ключ необязателен для запуска API, но
без него enrollment будет отключён; не добавляйте его в клиентские переменные
окружения, логи или репозиторий.

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