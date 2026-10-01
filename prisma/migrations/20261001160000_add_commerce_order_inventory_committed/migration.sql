ALTER TABLE "CommerceOrder"
    ADD COLUMN IF NOT EXISTS "inventoryCommitted" BOOLEAN NOT NULL DEFAULT false;
