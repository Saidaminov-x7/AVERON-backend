CREATE TABLE "CommerceRecentlyViewedProduct" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "sessionKey" TEXT,
    "productId" TEXT NOT NULL,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommerceRecentlyViewedProduct_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CommerceRecentlyViewedProduct_owner_check"
        CHECK (("userId" IS NOT NULL) <> ("sessionKey" IS NOT NULL))
);

CREATE UNIQUE INDEX "CommerceRecentlyViewedProduct_userId_productId_key"
    ON "CommerceRecentlyViewedProduct"("userId", "productId");
CREATE UNIQUE INDEX "CommerceRecentlyViewedProduct_sessionKey_productId_key"
    ON "CommerceRecentlyViewedProduct"("sessionKey", "productId");
CREATE INDEX "CommerceRecentlyViewedProduct_userId_viewedAt_idx"
    ON "CommerceRecentlyViewedProduct"("userId", "viewedAt");
CREATE INDEX "CommerceRecentlyViewedProduct_sessionKey_viewedAt_idx"
    ON "CommerceRecentlyViewedProduct"("sessionKey", "viewedAt");
CREATE INDEX "CommerceRecentlyViewedProduct_productId_idx"
    ON "CommerceRecentlyViewedProduct"("productId");

ALTER TABLE "CommerceRecentlyViewedProduct"
    ADD CONSTRAINT "CommerceRecentlyViewedProduct_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommerceRecentlyViewedProduct"
    ADD CONSTRAINT "CommerceRecentlyViewedProduct_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "CommerceProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
