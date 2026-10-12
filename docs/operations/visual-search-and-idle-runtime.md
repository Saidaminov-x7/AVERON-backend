# Visual Search and Railway idle runtime

## Current state

- The Jina image embedding adapter, Prisma image source, pgvector repository, and additive schema migration are implemented; targeted tests and TypeScript checks pass.
- Configure its secret as `JINA_API_KEY` on the AVERON backend service. Do not commit it, put it in a frontend/admin variable, or send it in chat.
- Keep `VISUAL_SEARCH_VECTOR_ENABLED`, `FEATURE_VISUAL_SEARCH`, `FEATURE_SIMILAR_PRODUCTS`, and `FEATURE_IMAGE_EMBEDDINGS` set to `false` until a pgvector-capable database is confirmed, the migration is applied, and end-to-end image indexing/search is verified.
- The migration adds a 1024-dimensional pgvector column and an HNSW cosine index. Railway's standard PostgreSQL image does not include pgvector. Do not apply this migration to a database without the extension; do not replace or migrate production data until the actual AVERON Railway project and backup/restore plan are confirmed.
- Reindexing only reads the main image attached to a published catalog product through the configured Media storage adapter. It will not fetch arbitrary product URLs, avoiding SSRF and unreviewed external hosts.
- No Jina key has been created or installed by this change, and no product/user images have been sent to Jina.

## Add the Jina secret yourself

1. In the Jina account intended for AVERON, create an API key in the API dashboard. Confirm the account's service terms and billing are suitable for a commercial store; do not enable auto-recharge or purchase credits without reviewing the amount.
2. In the correct Railway workspace, open the AVERON backend service and its intended environment, then open Variables.
3. Add `JINA_API_KEY` with the key value directly in Railway's secret input. Do not paste the value into chat, source files, `.env.example`, or a GitHub variable visible to frontend builds.
4. Leave `VISUAL_SEARCH_VECTOR_ENABLED` and all three visual-search feature flags off. Setting the key alone does not make search available.
5. After deployment, verify the admin integration diagnostics and test the image-search flow with non-personal test images before enabling public flags.

## Railway serverless readiness

The source now separates the Telegram `/start` and `/status` poller into `pnpm --filter api telegram:worker`, and the daily integrity-snapshot check plus pending-webhook retries into `pnpm --filter api maintenance:once`. The API no longer starts either background loop. API Prisma/Redis connections close after 60 seconds without in-flight requests and reconnect before the next request; failed dependency reconnects return a generic 503. The Telegram worker reuses the existing bot implementation and keys, and its long-poll request is aborted during shutdown.

This is an implementation in the backend working branch, not yet a production rollout. Railway still runs `main` at the deployment recorded below, has no Telegram worker or maintenance cron, and has Serverless disabled. Do not enable sleep on the API until this code is merged/deployed, then create one always-on Telegram worker with `TELEGRAM_TOKEN_2FA` (or the configured bot token), `TELEGRAM_ADMIN_CHAT_ID`, and `REDIS_URL` referencing the existing service values, plus a maintenance cron on `*/5 * * * *` with the same database/cache references. The current Railway cron minimum is five minutes; webhook retries may therefore be delayed up to five minutes. Keep PostgreSQL and Redis always on.

After deploying the workers, smoke-test admin Telegram 2FA and `/status`, webhook retry delivery, checkout, login, and health endpoints. Then enable Railway Serverless only for the API and deploy. Verify that it reaches `SLEEPING` after at least ten quiet minutes and that a real catalog/API request wakes it successfully; repeat after a cold start and check logs for connection failures. Do not claim the service sleeps until this lifecycle is observed live. The frontend's server-side requests and direct `GET /` visitors/bots are legitimate traffic and can wake the API; Railway sleep is inactivity-based, not based on whether a person is visibly browsing.

## Railway deployment audit — 2026-10-12

The correct Railway workspace is now confirmed: project `responsible-celebration` (`b8ccf297-96d5-4fdb-b1b6-ee81bc0d4be0`), production environment, service `AVERON-BACKEND` (`5c817a59-e294-404f-844e-659c54336619`). Its source is `Saidaminov-x7/AVERON-backend` on `main`; deployment `e2ff0519-fbd3-4aa7-b31d-8e06ab1e9dde` reported `SUCCESS` and the service domain is `averon-backend-production.up.railway.app`. The live config does not enable Serverless. No Railway setting or secret was changed during this audit.

Live HTTP logs included direct `GET /` and `GET /favicon.ico` requests as well as `GET /site-settings/public` from `node` clients. The latter are consistent with server-rendered frontend requests, but the log snapshot alone does not identify their exact originating project. Network-flow records showed repeated short requests to Telegram's `149.154.166.110:443`; together with the DNS resolution to `api.telegram.org` in the earlier deployment audit, this confirms the Telegram poll loop as a continuous source of outbound traffic. The metrics graph's small ingress/egress sawtooth is not by itself evidence of human visits.

Serverless remains unverified on production. The current working-branch changes pass the full API suite (68 test files, 447 tests), TypeScript type-check, ESLint, Prisma client generation/API build, and `git diff --check`. Staging integration tests, branch push/merge, worker/cron deployment, and cold-wake/idle-sleep verification remain outstanding. No Railway production setting or secret was changed during this turn.
