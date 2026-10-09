-- CreateEnum
CREATE TYPE "MasterDataChangeStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEntityType" ADD VALUE 'MASTER_DATA_CHANGE_REQUEST';
ALTER TYPE "AuditEntityType" ADD VALUE 'MASTER_DATA_VERSION';

-- CreateTable
CREATE TABLE "master_data_change_requests" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "entity_type" "AuditEntityType" NOT NULL,
    "entity_id" TEXT,
    "proposed_changes" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "MasterDataChangeStatus" NOT NULL DEFAULT 'DRAFT',
    "requested_by_id" TEXT NOT NULL,
    "approved_by_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "effective_date" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "master_data_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "master_data_versions" (
    "id" TEXT NOT NULL,
    "change_request_id" TEXT NOT NULL,
    "entity_type" "AuditEntityType" NOT NULL,
    "entity_id" TEXT,
    "version_number" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changed_fields" JSONB,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "effective_to" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "master_data_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "master_data_change_requests_organization_id_status_idx" ON "master_data_change_requests"("organization_id", "status");

-- CreateIndex
CREATE INDEX "master_data_change_requests_entity_type_entity_id_idx" ON "master_data_change_requests"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "master_data_change_requests_requested_by_id_idx" ON "master_data_change_requests"("requested_by_id");

-- CreateIndex
CREATE INDEX "master_data_change_requests_status_effective_date_idx" ON "master_data_change_requests"("status", "effective_date");

-- CreateIndex
CREATE INDEX "master_data_versions_entity_type_entity_id_idx" ON "master_data_versions"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "master_data_versions_effective_from_idx" ON "master_data_versions"("effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "master_data_versions_change_request_id_version_number_key" ON "master_data_versions"("change_request_id", "version_number");

-- AddForeignKey
ALTER TABLE "master_data_change_requests" ADD CONSTRAINT "master_data_change_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "master_data_change_requests" ADD CONSTRAINT "master_data_change_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "master_data_change_requests" ADD CONSTRAINT "master_data_change_requests_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "master_data_versions" ADD CONSTRAINT "master_data_versions_change_request_id_fkey" FOREIGN KEY ("change_request_id") REFERENCES "master_data_change_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
