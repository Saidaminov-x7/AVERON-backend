ALTER TABLE "User"
ADD COLUMN "wishlistShareToken" TEXT;

CREATE UNIQUE INDEX "User_wishlistShareToken_key" ON "User"("wishlistShareToken");

ALTER TABLE "ProductFavorite"
ADD CONSTRAINT "ProductFavorite_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Outfit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL DEFAULT 'My outfit',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Outfit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OutfitItem" (
    "id" TEXT NOT NULL,
    "outfitId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OutfitItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Outfit_userId_updatedAt_idx" ON "Outfit"("userId", "updatedAt");
CREATE INDEX "OutfitItem_outfitId_sortOrder_idx" ON "OutfitItem"("outfitId", "sortOrder");
CREATE INDEX "OutfitItem_productId_idx" ON "OutfitItem"("productId");
CREATE INDEX "OutfitItem_variantId_idx" ON "OutfitItem"("variantId");

ALTER TABLE "Outfit"
ADD CONSTRAINT "Outfit_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OutfitItem"
ADD CONSTRAINT "OutfitItem_outfitId_fkey"
FOREIGN KEY ("outfitId") REFERENCES "Outfit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OutfitItem"
ADD CONSTRAINT "OutfitItem_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "CommerceProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OutfitItem"
ADD CONSTRAINT "OutfitItem_variantId_fkey"
FOREIGN KEY ("variantId") REFERENCES "CommerceProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "CommercePromoCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "normalizedCode" TEXT NOT NULL,
    "discountPercent" INTEGER NOT NULL,
    "maxActivations" INTEGER,
    "usedActivations" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CommercePromoCode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommercePromoCodeUsage" (
    "id" TEXT NOT NULL,
    "promoCodeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "discountPercentSnapshot" INTEGER NOT NULL,
    "subtotal" DECIMAL(16,2) NOT NULL,
    "discountAmount" DECIMAL(16,2) NOT NULL,
    "finalTotal" DECIMAL(16,2) NOT NULL,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommercePromoCodeUsage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CommercePromoCode_normalizedCode_key" ON "CommercePromoCode"("normalizedCode");
CREATE INDEX "CommercePromoCode_isActive_startsAt_expiresAt_idx" ON "CommercePromoCode"("isActive", "startsAt", "expiresAt");
CREATE INDEX "CommercePromoCode_createdAt_idx" ON "CommercePromoCode"("createdAt");
CREATE UNIQUE INDEX "CommercePromoCodeUsage_orderId_key" ON "CommercePromoCodeUsage"("orderId");
CREATE UNIQUE INDEX "CommercePromoCodeUsage_promoCodeId_userId_key" ON "CommercePromoCodeUsage"("promoCodeId", "userId");
CREATE INDEX "CommercePromoCodeUsage_promoCodeId_usedAt_idx" ON "CommercePromoCodeUsage"("promoCodeId", "usedAt");
CREATE INDEX "CommercePromoCodeUsage_userId_usedAt_idx" ON "CommercePromoCodeUsage"("userId", "usedAt");

ALTER TABLE "CommercePromoCode"
ADD CONSTRAINT "CommercePromoCode_discountPercent_check"
CHECK ("discountPercent" BETWEEN 1 AND 15);

ALTER TABLE "CommercePromoCode"
ADD CONSTRAINT "CommercePromoCode_maxActivations_check"
CHECK ("maxActivations" IS NULL OR "maxActivations" > 0);

ALTER TABLE "CommercePromoCode"
ADD CONSTRAINT "CommercePromoCode_usedActivations_check"
CHECK ("usedActivations" >= 0);

ALTER TABLE "CommercePromoCodeUsage"
ADD CONSTRAINT "CommercePromoCodeUsage_discountPercentSnapshot_check"
CHECK ("discountPercentSnapshot" BETWEEN 1 AND 15);

ALTER TABLE "CommercePromoCodeUsage"
ADD CONSTRAINT "CommercePromoCodeUsage_promoCodeId_fkey"
FOREIGN KEY ("promoCodeId") REFERENCES "CommercePromoCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CommercePromoCodeUsage"
ADD CONSTRAINT "CommercePromoCodeUsage_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CommercePromoCodeUsage"
ADD CONSTRAINT "CommercePromoCodeUsage_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "CommerceOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
