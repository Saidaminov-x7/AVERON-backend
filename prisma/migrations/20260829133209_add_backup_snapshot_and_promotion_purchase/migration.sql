-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "BackupType" AS ENUM ('MANUAL', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "BackupStatus" AS ENUM ('COMPLETED', 'FAILED');

-- DropIndex
DROP INDEX "ThemeSettings_updatedById_idx";

-- AlterTable
ALTER TABLE "Page" ADD COLUMN     "isUnderMaintenance" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "SiteSettings" ADD COLUMN     "logoMediaKey" TEXT,
ADD COLUMN     "verificationEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "vipBoostEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "BackupSnapshot" (
    "id" TEXT NOT NULL,
    "triggeredBy" TEXT,
    "type" "BackupType" NOT NULL,
    "status" "BackupStatus" NOT NULL DEFAULT 'COMPLETED',
    "recordCounts" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackupSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionPurchase" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "tier" "PromotionTier" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'UZS',
    "status" "PurchaseStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BackupSnapshot_createdAt_idx" ON "BackupSnapshot"("createdAt");

-- CreateIndex
CREATE INDEX "PromotionPurchase_status_idx" ON "PromotionPurchase"("status");

-- CreateIndex
CREATE INDEX "PromotionPurchase_createdAt_idx" ON "PromotionPurchase"("createdAt");

-- AddForeignKey
ALTER TABLE "PromotionPurchase" ADD CONSTRAINT "PromotionPurchase_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
