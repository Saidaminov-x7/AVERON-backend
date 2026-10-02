CREATE TYPE "TelegramPublicationStatus" AS ENUM (
  'NOT_PUBLISHED',
  'PUBLISHING',
  'PUBLISHED',
  'FAILED'
);

CREATE TABLE "CommerceTelegramPublication" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "status" "TelegramPublicationStatus" NOT NULL DEFAULT 'NOT_PUBLISHED',
  "captionOverride" TEXT,
  "telegramMessageId" TEXT,
  "publishedAt" TIMESTAMP(3),
  "lastAttemptAt" TIMESTAMP(3),
  "errorCode" TEXT,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "createdById" TEXT,
  "lastAttemptById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CommerceTelegramPublication_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CommerceTelegramPublication_productId_channelId_key"
  ON "CommerceTelegramPublication"("productId", "channelId");
CREATE INDEX "CommerceTelegramPublication_status_updatedAt_idx"
  ON "CommerceTelegramPublication"("status", "updatedAt");

ALTER TABLE "CommerceTelegramPublication"
  ADD CONSTRAINT "CommerceTelegramPublication_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "CommerceProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommerceTelegramPublication"
  ADD CONSTRAINT "CommerceTelegramPublication_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CommerceTelegramPublication"
  ADD CONSTRAINT "CommerceTelegramPublication_lastAttemptById_fkey"
  FOREIGN KEY ("lastAttemptById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
