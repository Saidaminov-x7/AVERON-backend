-- This repository's checked-in migration history predates the deployed commerce
-- tables. Refuse to apply against a database that has not already been upgraded
-- to the commerce schema; do not synthesize or replace those existing tables.
DO $$
BEGIN
    IF to_regclass('"CommerceProduct"') IS NULL
       OR to_regclass('"CommerceProductVariant"') IS NULL
       OR to_regclass('"CommerceOrder"') IS NULL
       OR to_regclass('"CommerceOrderItem"') IS NULL
       OR to_regclass('"User"') IS NULL
       OR to_regclass('"CommerceOrderStatusHistory"') IS NULL
       OR NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AveronOrderStatus') THEN
        RAISE EXCEPTION 'Commerce schema prerequisite is missing; apply this additive migration only after the existing commerce schema is present';
    END IF;
END
$$;

ALTER TYPE "AveronOrderStatus" ADD VALUE IF NOT EXISTS 'CONFIRMED';

ALTER TABLE "CommerceProduct"
    ADD COLUMN IF NOT EXISTS "stock" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "CommerceOrderItem"
    ADD COLUMN IF NOT EXISTS "variantSnapshot" JSONB;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'CommerceProduct_stock_nonnegative_check'
          AND conrelid = '"CommerceProduct"'::regclass
    ) THEN
        ALTER TABLE "CommerceProduct"
            ADD CONSTRAINT "CommerceProduct_stock_nonnegative_check" CHECK ("stock" >= 0);
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "CommerceCart" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CommerceCart_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CommerceCart_userId_key" UNIQUE ("userId"),
    CONSTRAINT "CommerceCart_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "CommerceCartItem" (
    "id" TEXT NOT NULL,
    "cartId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CommerceCartItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CommerceCartItem_cartId_itemKey_key" UNIQUE ("cartId", "itemKey"),
    CONSTRAINT "CommerceCartItem_quantity_check" CHECK ("quantity" BETWEEN 1 AND 99),
    CONSTRAINT "CommerceCartItem_cartId_fkey"
        FOREIGN KEY ("cartId") REFERENCES "CommerceCart"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CommerceCartItem_productId_fkey"
        FOREIGN KEY ("productId") REFERENCES "CommerceProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CommerceCartItem_variantId_fkey"
        FOREIGN KEY ("variantId") REFERENCES "CommerceProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "CommerceCartItem_productId_idx" ON "CommerceCartItem"("productId");
CREATE INDEX IF NOT EXISTS "CommerceCartItem_variantId_idx" ON "CommerceCartItem"("variantId");

CREATE TABLE IF NOT EXISTS "CommerceCheckoutIdempotency" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommerceCheckoutIdempotency_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CommerceCheckoutIdempotency_userId_key_key" UNIQUE ("userId", "key"),
    CONSTRAINT "CommerceCheckoutIdempotency_orderId_key" UNIQUE ("orderId"),
    CONSTRAINT "CommerceCheckoutIdempotency_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CommerceCheckoutIdempotency_orderId_fkey"
        FOREIGN KEY ("orderId") REFERENCES "CommerceOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
