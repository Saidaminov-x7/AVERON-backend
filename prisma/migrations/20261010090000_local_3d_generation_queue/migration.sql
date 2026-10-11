ALTER TABLE "Product3DGenerationJob"
  ADD COLUMN "idempotencyKey" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  ADD COLUMN "requestHash" TEXT,
  ADD COLUMN "sourceImageIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "garmentLayer" "FittingGarmentLayer" NOT NULL DEFAULT 'BASE_TOP',
  ADD COLUMN "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "workerId" TEXT,
  ADD COLUMN "leaseToken" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "cancelRequestedAt" TIMESTAMP(3),
  ADD COLUMN "errorMessage" TEXT;

CREATE UNIQUE INDEX "Product3DGenerationJob_initiatedById_idempotencyKey_key"
  ON "Product3DGenerationJob"("initiatedById", "idempotencyKey");
CREATE INDEX "Product3DGenerationJob_status_nextAttemptAt_createdAt_idx"
  ON "Product3DGenerationJob"("status", "nextAttemptAt", "createdAt");
CREATE INDEX "Product3DGenerationJob_status_leaseExpiresAt_idx"
  ON "Product3DGenerationJob"("status", "leaseExpiresAt");
