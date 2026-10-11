ALTER TABLE "CommerceProduct"
ADD COLUMN "legacyPublicId" TEXT;

UPDATE "CommerceProduct"
SET "legacyPublicId" = "publicId";

CREATE SEQUENCE "CommerceProduct_public_id_seq"
  AS BIGINT
  START WITH 1
  INCREMENT BY 1
  NO MINVALUE
  NO MAXVALUE
  CACHE 1;

WITH numbered_products AS (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt" ASC, "id" ASC) AS number
  FROM "CommerceProduct"
)
UPDATE "CommerceProduct" AS product
SET "publicId" = 'AVR-' || LPAD(numbered_products.number::text, 15, '0')
FROM numbered_products
WHERE product."id" = numbered_products."id";

CREATE UNIQUE INDEX "CommerceProduct_legacyPublicId_key"
ON "CommerceProduct"("legacyPublicId");

SELECT setval(
  '"CommerceProduct_public_id_seq"',
  GREATEST(COUNT(*)::BIGINT, 1),
  COUNT(*) > 0
)
FROM "CommerceProduct";
