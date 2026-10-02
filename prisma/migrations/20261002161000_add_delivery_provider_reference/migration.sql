ALTER TABLE "CommerceDelivery"
ADD COLUMN "providerReference" TEXT;

CREATE UNIQUE INDEX "CommerceDelivery_providerReference_key"
ON "CommerceDelivery"("providerReference");
