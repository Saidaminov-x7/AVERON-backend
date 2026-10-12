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

## Railway serverless is not safe to toggle yet

The API process currently starts a Telegram `getUpdates` long-poll loop, an interval for scheduled backup snapshots, and a 60-second pending-webhook retry loop. It also owns persistent Prisma and Redis clients. Railway serverless sleeps only after a period with no outbound traffic; polling, database/Redis connections, and other service traffic can keep it awake. Enabling serverless now may therefore save nothing, while introducing cold-start latency and occasional first-request 502s.

Before enabling Railway Serverless on the AVERON API, move Telegram polling to a dedicated worker or replace it with a verified Telegram webhook, move backup and webhook retries to a worker/cron arrangement with durable retry state, and make database/cache connections reconnect safely after idle disconnect. Then test login/2FA, checkout, webhooks, health checks, cold starts, and retries on staging. Keep production serverless disabled until that test passes. Do not enable it on PostgreSQL or Redis.

## Railway deployment audit — 2026-10-12

The correct Railway workspace is now confirmed: project `responsible-celebration` (`b8ccf297-96d5-4fdb-b1b6-ee81bc0d4be0`), production environment, service `AVERON-BACKEND` (`5c817a59-e294-404f-844e-659c54336619`). Its source is `Saidaminov-x7/AVERON-backend` on `main`; deployment `e2ff0519-fbd3-4aa7-b31d-8e06ab1e9dde` reported `SUCCESS` and the service domain is `averon-backend-production.up.railway.app`. The live config does not enable Serverless. No Railway setting or secret was changed during this audit.

Serverless remains blocked on sleep-readiness work described above. In particular, the API must not lose its Telegram/2FA behavior, durable backup checks, webhook retry guarantees, or database/cache access after cold wake. The service is currently live; this audit alone does not prove a cold-start or idle-sleep cycle.
