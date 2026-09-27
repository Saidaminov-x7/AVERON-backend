-- CreateIndex
CREATE INDEX "Listing_city_district_type_status_price_idx" ON "Listing"("city", "district", "type", "status", "price");
