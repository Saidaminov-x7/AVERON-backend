-- Create migration
ALTER TABLE "SiteSettings"
ADD COLUMN "listingsPerPage" INTEGER NOT NULL DEFAULT 10;