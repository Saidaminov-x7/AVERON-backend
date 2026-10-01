CREATE TYPE "ProductImageEmbeddingStatus" AS ENUM ('PENDING', 'INDEXED', 'FAILED');

CREATE TABLE "ProductImageEmbedding" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productImageId" TEXT NOT NULL,
    "embeddingBytes" BYTEA,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "embeddingVersion" TEXT NOT NULL,
    "imageFingerprint" TEXT NOT NULL,
    "status" "ProductImageEmbeddingStatus" NOT NULL DEFAULT 'PENDING',
    "failureCode" TEXT,
    "indexedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductImageEmbedding_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProductImageEmbedding_dimensions_check" CHECK ("dimensions" > 0),
    CONSTRAINT "ProductImageEmbedding_indexed_bytes_check"
        CHECK ("status" <> 'INDEXED' OR "embeddingBytes" IS NOT NULL)
);

CREATE UNIQUE INDEX "ProductImageEmbedding_dedup_key"
    ON "ProductImageEmbedding"("productImageId", "provider", "model", "embeddingVersion", "imageFingerprint");
CREATE INDEX "ProductImageEmbedding_productId_status_idx"
    ON "ProductImageEmbedding"("productId", "status");
CREATE INDEX "ProductImageEmbedding_compatibility_idx"
    ON "ProductImageEmbedding"("embeddingVersion", "provider", "model", "dimensions", "status");

ALTER TABLE "ProductImageEmbedding"
    ADD CONSTRAINT "ProductImageEmbedding_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "CommerceProduct"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProductImageEmbedding"
    ADD CONSTRAINT "ProductImageEmbedding_productImageId_fkey"
    FOREIGN KEY ("productImageId") REFERENCES "CommerceProductImage"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
