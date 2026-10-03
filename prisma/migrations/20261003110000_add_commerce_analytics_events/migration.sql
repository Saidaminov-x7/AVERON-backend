CREATE TABLE "CommerceAnalyticsEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "productId" TEXT,
    "productViewDayKey" TEXT,
    "path" TEXT NOT NULL,
    "metadata" JSONB,
    "orderId" TEXT,
    "revenueUzs" DECIMAL(16,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommerceAnalyticsEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CommerceAnalyticsEvent_eventId_key" ON "CommerceAnalyticsEvent"("eventId");
CREATE UNIQUE INDEX "CommerceAnalyticsEvent_orderId_key" ON "CommerceAnalyticsEvent"("orderId");
CREATE INDEX "CommerceAnalyticsEvent_eventName_createdAt_idx" ON "CommerceAnalyticsEvent"("eventName", "createdAt");
CREATE INDEX "CommerceAnalyticsEvent_eventName_productId_createdAt_idx" ON "CommerceAnalyticsEvent"("eventName", "productId", "createdAt");
CREATE INDEX "CommerceAnalyticsEvent_deviceId_createdAt_idx" ON "CommerceAnalyticsEvent"("deviceId", "createdAt");
CREATE UNIQUE INDEX "CommerceAnalyticsEvent_deviceId_productId_productViewDayKey_key" ON "CommerceAnalyticsEvent"("deviceId", "productId", "productViewDayKey");
