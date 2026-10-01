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

## Feature flags и интеграции (Task #8)

Backend — источник истины для возможностей UI. Все внешние интеграции ниже
выключены по умолчанию; их наличие в коде не активирует их. Перед включением
требуются отдельное решение по deployment-конфигурации и проверка провайдера.
`GET /api/v1/capabilities` возвращает только публичные boolean-capabilities,
не содержит секретов. AI, SMS и Telegram capabilities также требуют backend
credentials/configuration; iPost, Pinduoduo, n8n и currency capability остаются
false пока не появятся реальные реализованные провайдеры. Сервер повторно
проверяет флаг на каждом защищённом пути.

| FEATURE | FLAG | DEFAULT | REPOSITORY | STATUS | REQUIREMENTS TO ENABLE |
|---|---|---:|---|---|---|
| AI Product Fill | `FEATURE_AI_PRODUCT_FILL` | `false` | Backend/Admin | Foundation; endpoint disabled | Approved OpenAI-compatible endpoint/model and backend-only `AI_PRODUCT_API_KEY` + `AI_PRODUCT_API_URL`; security and quality verification |
| 1688 parser/import | `FEATURE_1688_PARSER` | `false` | Parser/Backend | Prepared; import endpoint gated | Explicit activation, parser operational verification, import/review verification |
| Pinduoduo parser | `FEATURE_PINDUODUO_PARSER` | `false` | Parser/Backend | Disabled-provider foundation only | Official/authorized provider contract and explicit activation |
| iPost shipping | `FEATURE_IPOST` | `false` | Backend | Interface only; not production-ready | Official iPost API specification, credentials, and integration testing |
| n8n events | `FEATURE_N8N` | `false` | Backend | Event contracts only | Approved webhook/workflow design and backend-only credentials |
| Telegram product publishing | `FEATURE_TELEGRAM_PRODUCT_PUBLISH` | `false` | Backend | Existing publisher gated; no API calls while disabled | Explicit activation, verified channel/bot configuration, and human publication workflow review |
| Automatic currency | `FEATURE_AUTO_CURRENCY` | `false` | Backend | Interface only | Approved rate provider, source/quality policy, and explicit activation |
| SMS verification | `FEATURE_SMS_VERIFICATION` | `false` | Backend | Existing OTP paths gated; provider adapter retained | Approved SMS provider/configuration and end-to-end OTP verification |

Flags accept only the literal strings `true` or `false`. AI credentials, SMS
credentials, and Telegram credentials are backend-only. AI suggestions validate
the response structure, accept only localized copy and source-backed
characteristics, and return a draft; they never write products, approve imports,
or change publication status. The product-AI endpoint is authenticated,
rate-limited, and has a 20-second provider timeout. Unsupported shipping,
currency, and automation integrations do not issue external requests.

Parser imports use the existing review queue contract and remain pending human
review; no parser job is started automatically. Current iPost endpoints/API
credentials have not been supplied, so its provider remains an interface only.

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