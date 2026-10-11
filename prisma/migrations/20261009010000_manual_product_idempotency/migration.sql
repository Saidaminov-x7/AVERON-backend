ALTER TABLE "CommerceProduct"
ADD COLUMN "manualCreationKey" TEXT,
ADD COLUMN "manualCreationHash" TEXT;

CREATE UNIQUE INDEX "CommerceProduct_manualCreationKey_key"
ON "CommerceProduct"("manualCreationKey");
