ALTER TABLE "CommerceProduct" ADD COLUMN "publicId" TEXT;

-- Existing products also need a stable public URL. The generated identifier is
-- deliberately independent from the title/slug and follows xxxx-xxxx-xxxx-xxxx.
UPDATE "CommerceProduct"
SET "publicId" = lower(
  substr(md5(id::text || clock_timestamp()::text || random()::text), 1, 4) || '-' ||
  substr(md5(id::text || clock_timestamp()::text || random()::text), 5, 4) || '-' ||
  substr(md5(id::text || clock_timestamp()::text || random()::text), 9, 4) || '-' ||
  substr(md5(id::text || clock_timestamp()::text || random()::text), 13, 4)
)
WHERE "publicId" IS NULL;

ALTER TABLE "CommerceProduct" ALTER COLUMN "publicId" SET NOT NULL;

CREATE UNIQUE INDEX "CommerceProduct_publicId_key" ON "CommerceProduct"("publicId");
