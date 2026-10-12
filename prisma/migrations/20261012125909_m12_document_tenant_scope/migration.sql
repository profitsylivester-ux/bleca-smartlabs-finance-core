/*
  Warnings:

  - Added the required column `organization_id` to the `document_links` table without a default value. This is not possible if the table is not empty.
  - Added the required column `organization_id` to the `document_tag_links` table without a default value. This is not possible if the table is not empty.
  - Added the required column `organization_id` to the `document_versions` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "document_links_document_id_deleted_at_idx";

-- DropIndex
DROP INDEX "document_links_entity_type_entity_id_deleted_at_idx";

-- DropIndex
DROP INDEX "document_tag_links_tag_id_idx";

-- DropIndex
DROP INDEX "document_versions_document_id_created_at_idx";

-- AlterTable
ALTER TABLE "document_links" ADD COLUMN     "organization_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "document_tag_links" ADD COLUMN     "organization_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "document_versions" ADD COLUMN     "organization_id" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "document_links_organization_id_entity_type_entity_id_delete_idx" ON "document_links"("organization_id", "entity_type", "entity_id", "deleted_at");

-- CreateIndex
CREATE INDEX "document_links_organization_id_document_id_deleted_at_idx" ON "document_links"("organization_id", "document_id", "deleted_at");

-- CreateIndex
CREATE INDEX "document_tag_links_organization_id_tag_id_idx" ON "document_tag_links"("organization_id", "tag_id");

-- CreateIndex
CREATE INDEX "document_versions_organization_id_document_id_created_at_idx" ON "document_versions"("organization_id", "document_id", "created_at");

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_tag_links" ADD CONSTRAINT "document_tag_links_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_links" ADD CONSTRAINT "document_links_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
