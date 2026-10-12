-- Keep the database in sync with the SiteSettings Prisma model.
ALTER TABLE "SiteSettings"
ADD COLUMN IF NOT EXISTS "yandexMetrikaEnabled" BOOLEAN NOT NULL DEFAULT true;
