CREATE TYPE "CommerceDeliveryMethod" AS ENUM ('COURIER', 'PICKUP');

CREATE TYPE "CommerceDeliveryStatus" AS ENUM (
    'PENDING',
    'PREPARING',
    'SHIPPED',
    'IN_TRANSIT',
    'READY_FOR_DELIVERY',
    'DELIVERED',
    'CANCELLED'
);

CREATE TABLE "CommerceDelivery" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "method" "CommerceDeliveryMethod" NOT NULL DEFAULT 'COURIER',
    "recipient" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "destination" JSONB NOT NULL,
    "status" "CommerceDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "trackingNumber" TEXT,
    "provider" TEXT,
    "estimatedDeliveryAt" TIMESTAMP(3),
    "shippedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "providerMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommerceDelivery_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommerceDeliveryStatusHistory" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "status" "CommerceDeliveryStatus" NOT NULL,
    "note" TEXT,
    "changedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommerceDeliveryStatusHistory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CommerceDelivery_orderId_key" ON "CommerceDelivery"("orderId");
CREATE UNIQUE INDEX "CommerceDelivery_trackingNumber_key" ON "CommerceDelivery"("trackingNumber");
CREATE INDEX "CommerceDelivery_status_estimatedDeliveryAt_idx" ON "CommerceDelivery"("status", "estimatedDeliveryAt");
CREATE INDEX "CommerceDeliveryStatusHistory_deliveryId_createdAt_idx" ON "CommerceDeliveryStatusHistory"("deliveryId", "createdAt");

ALTER TABLE "CommerceDelivery"
    ADD CONSTRAINT "CommerceDelivery_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "CommerceOrder"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommerceDeliveryStatusHistory"
    ADD CONSTRAINT "CommerceDeliveryStatusHistory_deliveryId_fkey"
    FOREIGN KEY ("deliveryId") REFERENCES "CommerceDelivery"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
