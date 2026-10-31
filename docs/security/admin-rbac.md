# Admin API role boundaries

All administrative permissions are enforced by Fastify pre-handlers against the current user record in PostgreSQL. JWT role claims are not authoritative. Blocked or deleted accounts are denied before protected handlers run.

| Capability | SUPER_ADMIN | ADMIN | MODERATOR | SUPPORT |
| --- | --- | --- | --- | --- |
| User directory | Full admin DTO and contact search | Full admin DTO and contact search | Safe directory only | Safe directory only |
| User detail, export, activity, sessions, staff enumeration | Yes | Yes | No | No |
| Block or unblock a user | Yes | Yes | Yes; response omits contact details | No |
| Read product catalog and import queue | Yes | Yes | Yes | Yes |
| Create/edit/archive products or categories; create imports | Yes | Yes | No | No |
| Approve or reject imported products | Yes | Yes | Yes | No |
| Read/moderate product reviews | Yes | Yes | Yes | No |
| Read customer orders | Yes | Yes | No | Yes (support read access) |
| Change order or shipping status; create/sync iPost shipments | Yes | Yes | No | No |
| Manage promo codes, product AI, Telegram publication, integration diagnostics | Yes | Yes | No | No |
| Read analytics and global viewing-request queue | Yes | Yes | No | No |
| Read/resolve client error reports | Yes | Yes | No | Yes |

The general user directory and quick user search return only ID, name, account role, verification/block state, registration date, and avatar for MODERATOR/SUPPORT. Their searches do not match email or phone, and they cannot enumerate staff. User-owned viewing requests remain scoped to that user's listings; global contact-bearing queues are limited to ADMIN/SUPER_ADMIN.

Route-level regression coverage is in the API tests under `modules/admin`, `modules/analytics`, `modules/commerce`, `modules/error-reports`, and `modules/viewing-requests`. Authenticated browser E2E by role still requires a reachable staging deployment and separate test accounts.
