ALTER TABLE "CommerceProduct"
  ALTER COLUMN "sourceUrl" DROP NOT NULL;

ALTER TABLE "SiteSettings"
  ADD COLUMN "maxProductPhotos" INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN "maxProductPhotoSizeMb" INTEGER NOT NULL DEFAULT 10;

ALTER TABLE "CommerceProductImage"
  ADD COLUMN "mediaId" TEXT;

CREATE INDEX "CommerceProductImage_mediaId_idx"
  ON "CommerceProductImage"("mediaId");

ALTER TABLE "CommerceProductImage"
  ADD CONSTRAINT "CommerceProductImage_mediaId_fkey"
  FOREIGN KEY ("mediaId") REFERENCES "Media"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
