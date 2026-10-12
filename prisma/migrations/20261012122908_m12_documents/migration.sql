-- CreateEnum
CREATE TYPE "DocumentCategory" AS ENUM ('RECEIPT', 'INVOICE', 'QUOTATION', 'CONTRACT', 'GRANT_DOCUMENT', 'TAX_DOCUMENT', 'COMPLIANCE_DOCUMENT', 'FINANCIAL_EVIDENCE', 'ASSET_DOCUMENT', 'SUPPLIER_DOCUMENT', 'CUSTOMER_DOCUMENT', 'BANK_STATEMENT', 'RECONCILIATION_SUPPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('AVAILABLE', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "DocumentOcrStatus" AS ENUM ('NOT_RUN', 'QUEUED', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "DocumentLinkType" AS ENUM ('EVIDENCE', 'SUPPORTING', 'PRIMARY', 'CONTRACT', 'AMENDMENT');

-- CreateEnum
CREATE TYPE "RetentionAction" AS ENUM ('ARCHIVE', 'DELETE', 'RETAIN_FOREVER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEntityType" ADD VALUE 'DOCUMENT';
ALTER TYPE "AuditEntityType" ADD VALUE 'DOCUMENT_VERSION';
ALTER TYPE "AuditEntityType" ADD VALUE 'DOCUMENT_LINK';
ALTER TYPE "AuditEntityType" ADD VALUE 'DOCUMENT_TAG';
ALTER TYPE "AuditEntityType" ADD VALUE 'RETENTION_POLICY';
ALTER TYPE "AuditEntityType" ADD VALUE 'LEGAL_HOLD';

-- AlterEnum
ALTER TYPE "NotificationCategory" ADD VALUE 'DOCUMENT_EXPIRY';

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" "DocumentCategory" NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'AVAILABLE',
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "checksum" CHAR(64) NOT NULL,
    "storage_key" TEXT NOT NULL,
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "metadata" JSONB,
    "ocr_status" "DocumentOcrStatus" NOT NULL DEFAULT 'NOT_RUN',
    "ocr_text" TEXT,
    "ocr_confidence" DECIMAL(5,4),
    "expiry_date" DATE,
    "renewal_due_at" DATE,
    "renewal_of_id" TEXT,
    "approval_request_id" TEXT,
    "uploaded_by_id" TEXT NOT NULL,
    "approved_by_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "checksum" CHAR(64) NOT NULL,
    "storage_key" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_tags" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "document_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_tag_links" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "tag_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_tag_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_links" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "link_type" "DocumentLinkType" NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "document_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention_policies" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "DocumentCategory" NOT NULL,
    "retention_months" INTEGER NOT NULL,
    "action" "RetentionAction" NOT NULL,
    "legal_basis" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "retention_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_holds" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "held_by_id" TEXT NOT NULL,
    "approved_by_id" TEXT NOT NULL,
    "placed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMP(3),
    "released_by_id" TEXT,
    "release_reason" TEXT,

    CONSTRAINT "legal_holds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "documents_organization_id_category_status_deleted_at_idx" ON "documents"("organization_id", "category", "status", "deleted_at");

-- CreateIndex
CREATE INDEX "documents_organization_id_expiry_date_idx" ON "documents"("organization_id", "expiry_date");

-- CreateIndex
CREATE INDEX "documents_organization_id_renewal_due_at_idx" ON "documents"("organization_id", "renewal_due_at");

-- CreateIndex
CREATE INDEX "documents_renewal_of_id_idx" ON "documents"("renewal_of_id");

-- CreateIndex
CREATE UNIQUE INDEX "documents_organization_id_checksum_key" ON "documents"("organization_id", "checksum");

-- CreateIndex
CREATE UNIQUE INDEX "documents_organization_id_storage_key_key" ON "documents"("organization_id", "storage_key");

-- CreateIndex
CREATE INDEX "document_versions_document_id_created_at_idx" ON "document_versions"("document_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_document_id_version_key" ON "document_versions"("document_id", "version");

-- CreateIndex
CREATE INDEX "document_tags_organization_id_deleted_at_idx" ON "document_tags"("organization_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "document_tags_organization_id_name_key" ON "document_tags"("organization_id", "name");

-- CreateIndex
CREATE INDEX "document_tag_links_tag_id_idx" ON "document_tag_links"("tag_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_tag_links_document_id_tag_id_key" ON "document_tag_links"("document_id", "tag_id");

-- CreateIndex
CREATE INDEX "document_links_entity_type_entity_id_deleted_at_idx" ON "document_links"("entity_type", "entity_id", "deleted_at");

-- CreateIndex
CREATE INDEX "document_links_document_id_deleted_at_idx" ON "document_links"("document_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "document_links_document_id_entity_type_entity_id_link_type_key" ON "document_links"("document_id", "entity_type", "entity_id", "link_type");

-- CreateIndex
CREATE INDEX "retention_policies_organization_id_is_active_idx" ON "retention_policies"("organization_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "retention_policies_organization_id_category_key" ON "retention_policies"("organization_id", "category");

-- CreateIndex
CREATE INDEX "legal_holds_organization_id_entity_type_entity_id_released__idx" ON "legal_holds"("organization_id", "entity_type", "entity_id", "released_at");

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_supporting_document_id_fkey" FOREIGN KEY ("supporting_document_id") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_renewal_of_id_fkey" FOREIGN KEY ("renewal_of_id") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_tags" ADD CONSTRAINT "document_tags_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_tag_links" ADD CONSTRAINT "document_tag_links_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_tag_links" ADD CONSTRAINT "document_tag_links_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "document_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_links" ADD CONSTRAINT "document_links_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
