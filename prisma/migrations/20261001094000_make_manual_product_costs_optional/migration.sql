ALTER TABLE "CommerceProduct"
    ALTER COLUMN "originalPriceCny" DROP NOT NULL,
    ALTER COLUMN "exchangeRate" DROP NOT NULL;

ALTER TABLE "CommerceProductVariant"
    ALTER COLUMN "sourcePriceCny" DROP NOT NULL;
