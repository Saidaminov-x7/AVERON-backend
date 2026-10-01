-- Additive preorder foundation. Existing products remain preorder-ineligible and
-- existing order items remain ordinary stock-backed items by default.
DO $$
BEGIN
    IF to_regclass('"CommerceProduct"') IS NULL
       OR to_regclass('"CommerceOrderItem"') IS NULL THEN
        RAISE EXCEPTION 'Commerce product/order-item schema prerequisite is missing; apply preorder migration after commerce schema exists';
    END IF;
END
$$;

ALTER TABLE "CommerceProduct"
    ADD COLUMN IF NOT EXISTS "preorderEnabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "preorderLimit" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "preorderReserved" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "preorderEstimatedAt" TIMESTAMP(3);

ALTER TABLE "CommerceOrderItem"
    ADD COLUMN IF NOT EXISTS "isPreorder" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "preorderEstimatedAt" TIMESTAMP(3);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'CommerceProduct_preorder_limit_check'
          AND conrelid = '"CommerceProduct"'::regclass
    ) THEN
        ALTER TABLE "CommerceProduct"
            ADD CONSTRAINT "CommerceProduct_preorder_limit_check"
            CHECK ("preorderLimit" BETWEEN 0 AND 10000);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'CommerceProduct_preorder_reserved_check'
          AND conrelid = '"CommerceProduct"'::regclass
    ) THEN
        ALTER TABLE "CommerceProduct"
            ADD CONSTRAINT "CommerceProduct_preorder_reserved_check"
            CHECK ("preorderReserved" >= 0 AND "preorderReserved" <= "preorderLimit");
    END IF;
END
$$;
