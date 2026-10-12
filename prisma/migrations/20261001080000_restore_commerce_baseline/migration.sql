-- Restore the commerce baseline that existed before the country/pricing migrations.
-- The fresh Railway database already recorded the guarded country migration, so the
-- ProductCountry column and its index are included here explicitly.
-- CreateEnum
CREATE TYPE "ProductSource" AS ENUM ('SOURCE_1688', 'TAOBAO', 'ALIBABA', 'ALIEXPRESS', 'MANUAL');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('FETCHED', 'AI_PROCESSING', 'PENDING_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ProductPublicationStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AveronOrderStatus" AS ENUM ('CREATED', 'PAID', 'ORDERED_FROM_SUPPLIER', 'SUPPLIER_CONFIRMED', 'IN_TRANSIT_CHINA', 'CARGO_WAREHOUSE', 'INTERNATIONAL_TRANSIT', 'ARRIVED_UZBEKISTAN', 'OUT_FOR_DELIVERY', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentState" AS ENUM ('PENDING', 'PAID', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED');

-- CreateEnum
CREATE TYPE "SupplierPurchaseStatus" AS ENUM ('WAITING_FOR_PURCHASE', 'PURCHASED', 'SUPPLIER_CONFIRMED', 'SHIPPED', 'IN_TRANSIT', 'ARRIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ShipmentState" AS ENUM ('DRAFT', 'IN_TRANSIT_CHINA', 'AT_CARGO_WAREHOUSE', 'INTERNATIONAL_TRANSIT', 'ARRIVED_UZBEKISTAN', 'DELIVERED');

-- CreateEnum
CREATE TYPE "ExpenseType" AS ENUM ('PURCHASE', 'CARGO', 'PAYMENT_FEE', 'LOCAL_DELIVERY', 'REFUND', 'PACKAGING', 'MARKETING', 'OTHER');

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "listingId" TEXT,
    "landlordId" TEXT,
    "rating" INTEGER NOT NULL DEFAULT 5,
    "comment" TEXT NOT NULL,
    "status" "ModerationStatus" NOT NULL DEFAULT 'PENDING',
    "moderatedAt" TIMESTAMP(3),
    "moderatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminThemeSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "primaryColor" TEXT NOT NULL DEFAULT '#2563eb',
    "secondaryColor" TEXT NOT NULL DEFAULT '#1d4ed8',
    "backgroundColor" TEXT NOT NULL DEFAULT '#0f0f0f',
    "textColor" TEXT NOT NULL DEFAULT '#f1f5f9',
    "borderRadius" TEXT NOT NULL DEFAULT '0.5rem',
    "fontFamily" TEXT NOT NULL DEFAULT 'Inter, sans-serif',
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminThemeSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromoCodeUsage" (
    "id" TEXT NOT NULL,
    "promoCodeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromoCodeUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextRetryAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "responseCode" INTEGER,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommerceCategory" (
    "id" TEXT NOT NULL,
    "parentId" TEXT,
    "slug" TEXT NOT NULL,
    "name" JSONB NOT NULL,
    "description" JSONB,
    "imageUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommerceCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommerceProduct" (
    "id" TEXT NOT NULL,
    "country" "ProductCountry" NOT NULL,
    "categoryId" TEXT,
    "slug" TEXT NOT NULL,
    "translations" JSONB NOT NULL,
    "description" JSONB,
    "attributes" JSONB,
    "material" TEXT,
    "source" "ProductSource" NOT NULL,
    "sourceProductId" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "originalPriceCny" DECIMAL(14,2) NOT NULL,
    "exchangeRate" DECIMAL(14,4) NOT NULL,
    "salePriceUzs" DECIMAL(16,2) NOT NULL,
    "compareAtPriceUzs" DECIMAL(16,2),
    "status" "ProductPublicationStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "importedFromId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommerceProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommerceProductImage" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "alt" JSONB,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CommerceProductImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommerceProductVariant" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "sourceVariantId" TEXT,
    "color" TEXT,
    "size" TEXT,
    "sourcePriceCny" DECIMAL(14,2) NOT NULL,
    "salePriceUzs" DECIMAL(16,2) NOT NULL,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "CommerceProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportedProduct" (
    "id" TEXT NOT NULL,
    "source" "ProductSource" NOT NULL,
    "sourceProductId" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sellerId" TEXT,
    "originalTitle" TEXT NOT NULL,
    "sourcePriceCny" DECIMAL(14,2) NOT NULL,
    "sourceMetadata" JSONB,
    "normalizedPayload" JSONB NOT NULL,
    "aiPayload" JSONB,
    "aiWarnings" JSONB,
    "suggestedPriceUzs" DECIMAL(16,2),
    "expectedCostUzs" DECIMAL(16,2),
    "expectedProfitUzs" DECIMAL(16,2),
    "expectedMargin" DECIMAL(8,4),
    "status" "ImportStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "categoryId" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportedProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommerceOrder" (
    "id" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "AveronOrderStatus" NOT NULL DEFAULT 'CREATED',
    "currency" TEXT NOT NULL DEFAULT 'UZS',
    "subtotal" DECIMAL(16,2) NOT NULL,
    "discount" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "deliveryCost" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "totalRevenue" DECIMAL(16,2) NOT NULL,
    "purchaseCost" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "cargoCost" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "paymentFee" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "otherExpenses" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "refundAmount" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "netProfit" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "contact" JSONB NOT NULL,
    "deliveryAddress" JSONB NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommerceOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommerceOrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "title" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(16,2) NOT NULL,
    "totalPrice" DECIMAL(16,2) NOT NULL,

    CONSTRAINT "CommerceOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommerceOrderStatusHistory" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" "AveronOrderStatus" NOT NULL,
    "note" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommerceOrderStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommercePayment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerRef" TEXT,
    "amount" DECIMAL(16,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'UZS',
    "status" "PaymentState" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommercePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierPurchase" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "source" "ProductSource" NOT NULL,
    "sourceOrderId" TEXT,
    "sourceUrl" TEXT NOT NULL,
    "purchasePriceCny" DECIMAL(14,2) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "variant" JSONB,
    "seller" JSONB,
    "trackingNumber" TEXT,
    "status" "SupplierPurchaseStatus" NOT NULL DEFAULT 'WAITING_FOR_PURCHASE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CargoShipment" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'IPOST',
    "trackingNumber" TEXT NOT NULL,
    "weightKg" DECIMAL(10,3),
    "ratePerKg" DECIMAL(14,2),
    "cargoCost" DECIMAL(16,2),
    "status" "ShipmentState" NOT NULL DEFAULT 'DRAFT',
    "sentAt" TIMESTAMP(3),
    "arrivedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CargoShipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CargoShipmentItem" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "weightKg" DECIMAL(10,3),
    "allocatedCost" DECIMAL(16,2),

    CONSTRAINT "CargoShipmentItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommerceExpense" (
    "id" TEXT NOT NULL,
    "type" "ExpenseType" NOT NULL,
    "amount" DECIMAL(16,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "orderId" TEXT,
    "purchaseId" TEXT,
    "shipmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommerceExpense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductFavorite" (
    "userId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductFavorite_pkey" PRIMARY KEY ("userId","productId")
);

-- CreateTable
CREATE TABLE "ProductPriceAlert" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "targetPrice" DECIMAL(16,2) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductPriceAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomOrderRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "source" "ProductSource" NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "parsedPayload" JSONB,
    "selectedVariant" JSONB,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "contact" JSONB NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomOrderRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Review_authorId_idx" ON "Review"("authorId");

-- CreateIndex
CREATE INDEX "Review_listingId_idx" ON "Review"("listingId");

-- CreateIndex
CREATE INDEX "Review_landlordId_idx" ON "Review"("landlordId");

-- CreateIndex
CREATE INDEX "Review_status_idx" ON "Review"("status");

-- CreateIndex
CREATE INDEX "Review_createdAt_idx" ON "Review"("createdAt");

-- CreateIndex
CREATE INDEX "PromoCodeUsage_userId_idx" ON "PromoCodeUsage"("userId");

-- CreateIndex
CREATE INDEX "PromoCodeUsage_promoCodeId_idx" ON "PromoCodeUsage"("promoCodeId");

-- CreateIndex
CREATE UNIQUE INDEX "PromoCodeUsage_promoCodeId_userId_key" ON "PromoCodeUsage"("promoCodeId", "userId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_webhookId_idx" ON "WebhookDelivery"("webhookId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_idx" ON "WebhookDelivery"("status");

-- CreateIndex
CREATE INDEX "WebhookDelivery_nextRetryAt_idx" ON "WebhookDelivery"("nextRetryAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommerceCategory_slug_key" ON "CommerceCategory"("slug");

-- CreateIndex
CREATE INDEX "CommerceCategory_parentId_sortOrder_idx" ON "CommerceCategory"("parentId", "sortOrder");

-- CreateIndex
CREATE INDEX "CommerceCategory_active_idx" ON "CommerceCategory"("active");

-- CreateIndex
CREATE UNIQUE INDEX "CommerceProduct_slug_key" ON "CommerceProduct"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "CommerceProduct_importedFromId_key" ON "CommerceProduct"("importedFromId");

-- CreateIndex
CREATE INDEX "CommerceProduct_status_createdAt_idx" ON "CommerceProduct"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CommerceProduct_categoryId_status_idx" ON "CommerceProduct"("categoryId", "status");

-- CreateIndex
CREATE INDEX "CommerceProduct_salePriceUzs_idx" ON "CommerceProduct"("salePriceUzs");

-- CreateIndex
CREATE UNIQUE INDEX "CommerceProduct_source_sourceProductId_key" ON "CommerceProduct"("source", "sourceProductId");

-- CreateIndex
CREATE INDEX "CommerceProductImage_productId_sortOrder_idx" ON "CommerceProductImage"("productId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "CommerceProductVariant_sku_key" ON "CommerceProductVariant"("sku");

-- CreateIndex
CREATE INDEX "CommerceProductVariant_productId_active_idx" ON "CommerceProductVariant"("productId", "active");

-- CreateIndex
CREATE INDEX "ImportedProduct_status_createdAt_idx" ON "ImportedProduct"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ImportedProduct_categoryId_idx" ON "ImportedProduct"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "ImportedProduct_source_sourceProductId_key" ON "ImportedProduct"("source", "sourceProductId");

-- CreateIndex
CREATE UNIQUE INDEX "CommerceOrder_orderNumber_key" ON "CommerceOrder"("orderNumber");

-- CreateIndex
CREATE INDEX "CommerceOrder_userId_createdAt_idx" ON "CommerceOrder"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "CommerceOrder_status_createdAt_idx" ON "CommerceOrder"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CommerceOrderItem_orderId_idx" ON "CommerceOrderItem"("orderId");

-- CreateIndex
CREATE INDEX "CommerceOrderItem_productId_idx" ON "CommerceOrderItem"("productId");

-- CreateIndex
CREATE INDEX "CommerceOrderStatusHistory_orderId_createdAt_idx" ON "CommerceOrderStatusHistory"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "CommercePayment_orderId_status_idx" ON "CommercePayment"("orderId", "status");

-- CreateIndex
CREATE INDEX "SupplierPurchase_orderId_status_idx" ON "SupplierPurchase"("orderId", "status");

-- CreateIndex
CREATE INDEX "SupplierPurchase_trackingNumber_idx" ON "SupplierPurchase"("trackingNumber");

-- CreateIndex
CREATE UNIQUE INDEX "CargoShipment_trackingNumber_key" ON "CargoShipment"("trackingNumber");

-- CreateIndex
CREATE INDEX "CargoShipment_status_createdAt_idx" ON "CargoShipment"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CargoShipmentItem_shipmentId_purchaseId_key" ON "CargoShipmentItem"("shipmentId", "purchaseId");

-- CreateIndex
CREATE INDEX "CommerceExpense_orderId_idx" ON "CommerceExpense"("orderId");

-- CreateIndex
CREATE INDEX "CommerceExpense_type_createdAt_idx" ON "CommerceExpense"("type", "createdAt");

-- CreateIndex
CREATE INDEX "ProductFavorite_userId_idx" ON "ProductFavorite"("userId");

-- CreateIndex
CREATE INDEX "ProductPriceAlert_userId_active_idx" ON "ProductPriceAlert"("userId", "active");

-- CreateIndex
CREATE INDEX "ProductPriceAlert_productId_idx" ON "ProductPriceAlert"("productId");

-- CreateIndex
CREATE INDEX "CustomOrderRequest_status_createdAt_idx" ON "CustomOrderRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CustomOrderRequest_userId_idx" ON "CustomOrderRequest"("userId");

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_landlordId_fkey" FOREIGN KEY ("landlordId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoCodeUsage" ADD CONSTRAINT "PromoCodeUsage_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "PromoCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoCodeUsage" ADD CONSTRAINT "PromoCodeUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "SystemWebhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceCategory" ADD CONSTRAINT "CommerceCategory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "CommerceCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceProduct" ADD CONSTRAINT "CommerceProduct_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "CommerceCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceProduct" ADD CONSTRAINT "CommerceProduct_importedFromId_fkey" FOREIGN KEY ("importedFromId") REFERENCES "ImportedProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceProductImage" ADD CONSTRAINT "CommerceProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "CommerceProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceProductVariant" ADD CONSTRAINT "CommerceProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "CommerceProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportedProduct" ADD CONSTRAINT "ImportedProduct_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "CommerceCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceOrderItem" ADD CONSTRAINT "CommerceOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CommerceOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceOrderItem" ADD CONSTRAINT "CommerceOrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "CommerceProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceOrderItem" ADD CONSTRAINT "CommerceOrderItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "CommerceProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceOrderStatusHistory" ADD CONSTRAINT "CommerceOrderStatusHistory_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CommerceOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommercePayment" ADD CONSTRAINT "CommercePayment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CommerceOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPurchase" ADD CONSTRAINT "SupplierPurchase_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CommerceOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CargoShipmentItem" ADD CONSTRAINT "CargoShipmentItem_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "CargoShipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CargoShipmentItem" ADD CONSTRAINT "CargoShipmentItem_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "SupplierPurchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceExpense" ADD CONSTRAINT "CommerceExpense_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CommerceOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceExpense" ADD CONSTRAINT "CommerceExpense_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "SupplierPurchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceExpense" ADD CONSTRAINT "CommerceExpense_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "CargoShipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductFavorite" ADD CONSTRAINT "ProductFavorite_productId_fkey" FOREIGN KEY ("productId") REFERENCES "CommerceProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductPriceAlert" ADD CONSTRAINT "ProductPriceAlert_productId_fkey" FOREIGN KEY ("productId") REFERENCES "CommerceProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "CommerceProduct_country_status_createdAt_idx" ON "CommerceProduct"("country", "status", "createdAt");

