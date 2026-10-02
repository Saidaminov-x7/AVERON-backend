CREATE TYPE "CommerceProductReviewStatus" AS ENUM ('PENDING', 'PUBLISHED', 'REJECTED');
CREATE TYPE "CommerceProductReviewFit" AS ENUM ('RUNS_SMALL', 'TRUE_TO_SIZE', 'RUNS_LARGE');

CREATE TABLE "CommerceProductReview" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "orderItemId" TEXT NOT NULL,
  "rating" INTEGER NOT NULL,
  "title" TEXT,
  "comment" TEXT NOT NULL,
  "status" "CommerceProductReviewStatus" NOT NULL DEFAULT 'PENDING',
  "verifiedPurchase" BOOLEAN NOT NULL DEFAULT false,
  "fitFeedback" "CommerceProductReviewFit",
  "moderatedAt" TIMESTAMP(3),
  "moderatedById" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommerceProductReview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommerceProductReview_rating_check" CHECK ("rating" BETWEEN 1 AND 5)
);

CREATE TABLE "CommerceProductReviewMedia" (
  "id" TEXT NOT NULL,
  "reviewId" TEXT NOT NULL,
  "mediaId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommerceProductReviewMedia_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CommerceProductReview_orderItemId_key" ON "CommerceProductReview"("orderItemId");
CREATE INDEX "CommerceProductReview_productId_status_createdAt_idx" ON "CommerceProductReview"("productId", "status", "createdAt");
CREATE INDEX "CommerceProductReview_userId_createdAt_idx" ON "CommerceProductReview"("userId", "createdAt");
CREATE INDEX "CommerceProductReview_orderId_idx" ON "CommerceProductReview"("orderId");
CREATE INDEX "CommerceProductReview_rating_status_idx" ON "CommerceProductReview"("rating", "status");
CREATE UNIQUE INDEX "CommerceProductReviewMedia_mediaId_key" ON "CommerceProductReviewMedia"("mediaId");
CREATE INDEX "CommerceProductReviewMedia_reviewId_createdAt_idx" ON "CommerceProductReviewMedia"("reviewId", "createdAt");

ALTER TABLE "CommerceProductReview"
  ADD CONSTRAINT "CommerceProductReview_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "CommerceProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CommerceProductReview_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CommerceProductReview_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "CommerceOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CommerceProductReview_orderItemId_fkey"
  FOREIGN KEY ("orderItemId") REFERENCES "CommerceOrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CommerceProductReview_moderatedById_fkey"
  FOREIGN KEY ("moderatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CommerceProductReviewMedia"
  ADD CONSTRAINT "CommerceProductReviewMedia_reviewId_fkey"
  FOREIGN KEY ("reviewId") REFERENCES "CommerceProductReview"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CommerceProductReviewMedia_mediaId_fkey"
  FOREIGN KEY ("mediaId") REFERENCES "Media"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
