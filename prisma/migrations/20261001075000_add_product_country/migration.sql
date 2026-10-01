CREATE TYPE "ProductCountry" AS ENUM ('CN', 'US', 'TR', 'IT', 'GB');

DO $$
BEGIN
    IF to_regclass('"CommerceProduct"') IS NOT NULL THEN
        ALTER TABLE "CommerceProduct"
            ADD COLUMN IF NOT EXISTS "country" "ProductCountry" NOT NULL DEFAULT 'CN';

        UPDATE "CommerceProduct"
        SET "country" = 'CN'
        WHERE "country" IS NULL;

        ALTER TABLE "CommerceProduct"
            ALTER COLUMN "country" SET NOT NULL,
            ALTER COLUMN "country" DROP DEFAULT;

        CREATE INDEX IF NOT EXISTS "CommerceProduct_country_status_createdAt_idx"
            ON "CommerceProduct"("country", "status", "createdAt");
    END IF;
END $$;
