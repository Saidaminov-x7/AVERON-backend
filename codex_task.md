Задачи безопасности для backend (объединённый список, выполняй по одной,
отдельными коммитами, прогоняй тесты после каждой).

## 1. [MEDIUM] Trusted proxy identity
Найди конфигурацию Fastify trustProxyOption и TRUST_PROXY_ADDRESSES.
Не меняй дефолт на "доверять всем". Добавь тесты, доказывающие, что при
пустом TRUST_PROXY_ADDRESSES X-Forwarded-For полностью игнорируется —
включая кейсы с несколькими значениями заголовка, IPv6, попытками
спуфинга. Подготовь краткую инструкцию (markdown), что оператору нужно
внести в TRUST_PROXY_ADDRESSES в staging/production — не угадывай сами
диапазоны Railway/Cloudflare, оставь явный TODO для оператора.

## 2. [MEDIUM] API route coverage
Открой docs/api-endpoint-registry.json (в соседнем репозитории
AVERON_security_tests, путь ../AVERON_security_tests/docs/api-endpoint-registry.json,
если недоступен — пропусти и работай по своим знаниям роутов).
Выбери 10-15 самых приоритетных NOT_TESTED роутов: auth, payments/orders,
admin-mutations. Добавь fastify.inject-тесты: нет токена -> 401, неверная
роль -> 403, валидный запрос -> ожидаемый статус. Не трогай бизнес-логику.

## 3. [LOW] Lint debt
Пройдись по no-explicit-any и no-unused-vars ТОЛЬКО на границах с внешним
вводом (route handlers, DTO-парсинг, привилегированные операции). Не трогай
остальной код. Никаких eslint-disable для "зачистки счётчика".

Общие правила: не трогай production базу/секреты/деплой-конфиг. После
каждого пункта — summary (что изменено, какие тесты прогнаны, что не
проверено). Коммить локально, не пушить.
