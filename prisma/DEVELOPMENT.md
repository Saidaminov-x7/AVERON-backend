# Development database seed

The seed command is for local development and staging only. It refuses to run
when `NODE_ENV=production`, does not contain a default password, and requires
explicit credentials before creating the development administrator.

Set `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, and `SEED_ADMIN_PHONE` in your
local environment, then run `pnpm prisma:seed` from `apps/api`. The password
must be at least 8 characters and include an uppercase letter, a lowercase
letter, and a digit. Do not commit these values or use them as production
credentials.
