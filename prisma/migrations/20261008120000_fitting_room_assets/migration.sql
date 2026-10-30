CREATE TYPE "FittingGarmentLayer" AS ENUM (
  'BASE_TOP',
  'MID_LAYER',
  'OUTERWEAR',
  'BOTTOM',
  'FOOTWEAR',
  'ACCESSORY'
);

CREATE TYPE "Product3DAssetStatus" AS ENUM ('NEEDS_REVIEW', 'APPROVED', 'REJECTED');
CREATE TYPE "Product3DAssetSource" AS ENUM ('MANUAL', 'LOCAL_GENERATION');
CREATE TYPE "Product3DGenerationStatus" AS ENUM (
  'QUEUED',
  'RUNNING',
  'POSTPROCESSING',
  'NEEDS_REVIEW',
  'COMPLETED',
  'FAILED',
  'CANCELLED'
);

CREATE TABLE "Product3DAsset" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "variantId" TEXT,
  "fileKey" TEXT NOT NULL,
  "fileHash" TEXT NOT NULL,
  "fileSize" INTEGER NOT NULL,
  "status" "Product3DAssetStatus" NOT NULL DEFAULT 'NEEDS_REVIEW',
  "source" "Product3DAssetSource" NOT NULL DEFAULT 'MANUAL',
  "garmentLayer" "FittingGarmentLayer" NOT NULL,
  "mannequinVersion" TEXT NOT NULL DEFAULT 'averon-neutral-v1',
  "modelVersion" TEXT NOT NULL DEFAULT '1',
  "sourceImageIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "validationSummary" TEXT,
  "validationDetails" JSONB,
  "positionX" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "positionY" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "positionZ" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "scale" DOUBLE PRECISION NOT NULL DEFAULT 1,
  "reviewedById" TEXT,
  "approvedAt" TIMESTAMP(3),
  "rejectionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Product3DAsset_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Product3DAsset_productId_fkey" FOREIGN KEY ("productId") REFERENCES "CommerceProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Product3DAsset_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "CommerceProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "Product3DGenerationJob" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "variantId" TEXT,
  "initiatedById" TEXT NOT NULL,
  "status" "Product3DGenerationStatus" NOT NULL DEFAULT 'QUEUED',
  "stage" TEXT NOT NULL DEFAULT 'QUEUED',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "errorCode" TEXT,
  "resultAssetId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Product3DGenerationJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Product3DGenerationJob_productId_fkey" FOREIGN KEY ("productId") REFERENCES "CommerceProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Product3DAsset_fileKey_key" ON "Product3DAsset"("fileKey");
CREATE INDEX "Product3DAsset_fileHash_idx" ON "Product3DAsset"("fileHash");
CREATE INDEX "Product3DAsset_productId_status_idx" ON "Product3DAsset"("productId", "status");
CREATE INDEX "Product3DAsset_variantId_status_idx" ON "Product3DAsset"("variantId", "status");
CREATE INDEX "Product3DAsset_garmentLayer_status_idx" ON "Product3DAsset"("garmentLayer", "status");
CREATE UNIQUE INDEX "Product3DGenerationJob_resultAssetId_key" ON "Product3DGenerationJob"("resultAssetId");
CREATE INDEX "Product3DGenerationJob_status_createdAt_idx" ON "Product3DGenerationJob"("status", "createdAt");
CREATE INDEX "Product3DGenerationJob_productId_status_idx" ON "Product3DGenerationJob"("productId", "status");
