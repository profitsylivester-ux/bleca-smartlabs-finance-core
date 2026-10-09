-- CreateIndex
CREATE INDEX "access_review_items_role_id_idx" ON "access_review_items"("role_id");

-- AddForeignKey
ALTER TABLE "access_review_items" ADD CONSTRAINT "access_review_items_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
