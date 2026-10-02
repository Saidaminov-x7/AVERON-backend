# Task 18 deployment and integration operations

## Current implementation status

| Capability | Status |
| --- | --- |
| Shared Redis rate limiting | `IMPLEMENTED`; shared store and fail-closed on store errors |
| SMS provider boundary | `IMPLEMENTED`, `NOT_CONFIGURED`, `NOT_LIVE_VERIFIED`; disabled by default |
| n8n event delivery | `TESTED_WITH_MOCK`, `NOT_CONFIGURED`, `NOT_LIVE_VERIFIED`; disabled by default |
| 1688 Parser | `IMPLEMENTED`, `NOT_LIVE_VERIFIED`; URL checks, a pinned-IP egress proxy for Chromium tunnels, per-connection DNS/IP validation, and a two-request Playwright concurrency bound are enforced in source |
| Pinduoduo provider | `TESTED_WITH_MOCK`, `BLOCKED_BY_PROVIDER`, `NOT_LIVE_VERIFIED`; normalized adapter is tested, but no real transport is registered |
| iPost shipping | `TESTED_WITH_MOCK`, `NOT_CONFIGURED`, `NOT_LIVE_VERIFIED`; the admin-only provider boundary enforces DB row locking, stable provider idempotency keys, bounded retries/timeouts, and records normalized status as provider evidence without mutating internal delivery status. No official iPost API contract, transport adapter, or credentials are available to safely make live calls |
| Currency rate core | `IMPLEMENTED`; provider-neutral CNY→UZS rate validation and a versioned Redis-compatible cache boundary are tested with a mock provider. No real rate provider is registered, so `FEATURE_AUTO_CURRENCY=false`, diagnostics show no current rate, and stale data is returned only when both the caller and business policy explicitly allow it |
| Cloudflare edge/origin rules | `NOT_CONFIGURED`; deployer configuration is required |

Credentials belong only in the server environment. `.env.example` intentionally leaves signing keys and provider credentials empty.

## Railway environments and scaling

Use separate Railway project environments for development, test, staging, and production. Each environment needs its own PostgreSQL, Redis, secrets, public URLs, Telegram destination, and provider configuration. Never copy production credentials into test variables.

Fastify does not trust forwarded client-IP headers unless `TRUST_PROXY_ADDRESSES` lists verified proxy IPs/CIDRs. Leave it empty until the deployed Cloudflare/Railway chain and trusted source ranges are confirmed. Do not use `true`, `*`, or caller-controlled `X-Forwarded-For` values. An empty setting uses the direct TCP peer address and may aggregate requests behind an ingress proxy; validate rate-limit behavior in staging before launch.

The backend is configured in `railway.json` with `/health/live` for process liveness. `/health/ready` reports dependency readiness using booleans; `/health` returns only coarse dependency state and does not return exception text. PostgreSQL migrations run through the container entrypoint with `prisma migrate deploy`; do not substitute `db push` or a reset command.

Use one shared Redis service for all API replicas. It backs distributed rate limiting and selected ephemeral coordination. Rate-limit storage errors fail closed rather than bypassing limits. Keep Redis persistence/backups appropriate to the required recovery objective; the n8n diagnostic list is bounded to 100 entries and is not a PostgreSQL outbox or guaranteed delivery queue.

Set Prisma's PostgreSQL `connection_limit` per API replica so that `replicas × connection_limit`, plus other clients, stays within the database or pooler's connection budget. Revisit the budget whenever replica count or database capacity changes. Do not construct Prisma clients per request.

## n8n

Deploy n8n as a separate Railway service. Use a persistent PostgreSQL database for n8n workflows/execution state, set a stable random `N8N_ENCRYPTION_KEY`, and back up both its database and encryption key. Protect the editor with n8n's supported authentication/access-control configuration and expose only the webhook surface needed by workflows. Do not expose an unauthenticated public editor.

Where the Railway environment supports private networking, point `N8N_WEBHOOK_URL` at the n8n service's private DNS name, for example `http://n8n.railway.internal:<port>/webhook/<path>`. Railway documents private service traffic as using encrypted WireGuard tunnels. Otherwise use an HTTPS endpoint. Set `FEATURE_N8N=true` only with a valid endpoint and a unique secret of at least 32 characters:

- `N8N_WEBHOOK_URL`
- `N8N_WEBHOOK_SECRET`

The backend sends a JSON domain event with `x-averon-timestamp`, `x-averon-signature` (`sha256=` plus HMAC-SHA256 over `timestamp.body`), and `x-averon-event-id`. Configure the receiving workflow to reject timestamps outside a short freshness window, verify the HMAC before acting, and deduplicate event IDs. Never put core checkout or inventory decisions in n8n. Delivery is bounded and asynchronous with respect to the business request; failures are logged and placed in a bounded Redis diagnostic list, but automatic replay/durable outbox delivery is not implemented.

## Cloudflare and origin

For public storefront/API hostnames, use the Railway-assigned custom-domain DNS target and Cloudflare proxying only after verifying the domain and certificate. Set Cloudflare SSL/TLS to **Full (strict)**. Enable suitable WAF and rate-limit rules for authentication, OTP, checkout, and administrative endpoints, subject to the Cloudflare plan.

Cache only explicitly public static assets. Bypass cache for all API responses by default, including `/api/v1/auth/*`, `/api/v1/cart*`, `/api/v1/checkout*`, `/api/v1/orders*`, `/api/v1/admin*`, user-specific recommendations, and wishlist state. Never cache authenticated responses under a shared cache key.

Railway provides public domains and (on plans with the feature) edge rules that can match client IP, host, path, or headers. No Cloudflare allowlist or origin restriction is configured in this repository. A provisioned Railway public domain may therefore remain directly reachable unless disabled or constrained in that environment. If using Railway edge rules to restrict origin access to Cloudflare, maintain the current Cloudflare source ranges and test both proxied and direct-origin paths before relying on the rule. Do not claim origin restriction until it is verified in the Railway environment.

## Deployment verification

1. Confirm each environment has unique PostgreSQL/Redis URLs and secrets.
2. Confirm `FEATURE_*` values remain `false` unless the corresponding provider configuration has been reviewed.
3. Confirm `/health/live` and `/health/ready` through the intended route.
4. Verify `/api/v1` is bypassed by Cloudflare caching and test that user A cannot receive user B's response.
5. Verify direct Railway-origin access is either intentionally available or explicitly blocked by a tested supported control.
6. Verify n8n signature validation, freshness rejection, event-ID deduplication, persistence, backups, and editor access controls before enabling `FEATURE_N8N`.
