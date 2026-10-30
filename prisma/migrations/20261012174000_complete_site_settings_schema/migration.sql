-- Restore fields present in the current Prisma model but absent from the
-- historical SiteSettings migrations. These are additive and preserve rows.
ALTER TABLE "SiteSettings"
  ADD COLUMN IF NOT EXISTS "maintenanceBypassPassword" TEXT,
  ADD COLUMN IF NOT EXISTS "maintenancePasswordEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "mobilePinchZoomEnabled" BOOLEAN NOT NULL DEFAULT true;

-- Align database defaults with prisma/schema.prisma for newly created rows.
ALTER TABLE "SiteSettings"
  ALTER COLUMN "siteName" SET DEFAULT 'AVERON',
  ALTER COLUMN "contactEmail" SET DEFAULT '',
  ALTER COLUMN "contactPhone" SET DEFAULT '',
  ALTER COLUMN "googleAuthEnabled" SET DEFAULT false;
