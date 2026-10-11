-- CreateEnum
CREATE TYPE "ImportSource" AS ENUM ('EXCEL', 'CSV', 'API', 'MANUAL');

-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('UPLOADED', 'MAPPING', 'VALIDATING', 'PREVIEW', 'AWAITING_APPROVAL', 'APPROVED', 'IMPORTING', 'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "ImportErrorType" AS ENUM ('VALIDATION', 'DUPLICATE', 'MAPPING', 'PERMISSION', 'SYSTEM', 'PARSE');

-- CreateTable
CREATE TABLE "import_batches" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "source" "ImportSource" NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_hash" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "mime_type" TEXT NOT NULL,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'UPLOADED',
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "valid_rows" INTEGER NOT NULL DEFAULT 0,
    "error_rows" INTEGER NOT NULL DEFAULT 0,
    "duplicate_rows" INTEGER NOT NULL DEFAULT 0,
    "uploaded_by_id" TEXT NOT NULL,
    "mapped_by_id" TEXT,
    "validated_by_id" TEXT,
    "approved_by_id" TEXT,
    "imported_by_id" TEXT,
    "rolled_back_by_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "imported_at" TIMESTAMP(3),
    "rolled_back_at" TIMESTAMP(3),
    "error_summary" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_rows" (
    "id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "row_number" INTEGER NOT NULL,
    "raw_data" JSONB NOT NULL,
    "mapped_data" JSONB,
    "normalized_data" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "fingerprint" TEXT,
    "imported_transaction_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_field_mappings" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "batch_id" TEXT,
    "source" "ImportSource" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "date_format" TEXT NOT NULL,
    "amount_convention" TEXT NOT NULL,
    "decimal_separator" TEXT NOT NULL DEFAULT '.',
    "thousand_separator" TEXT NOT NULL DEFAULT ',',
    "encoding" TEXT NOT NULL DEFAULT 'UTF-8',
    "has_header" BOOLEAN NOT NULL DEFAULT true,
    "column_map" JSONB NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_field_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_errors" (
    "id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "row_id" TEXT,
    "row_number" INTEGER NOT NULL,
    "type" "ImportErrorType" NOT NULL,
    "field" TEXT,
    "original_value" JSONB,
    "message" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'ERROR',
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolved_by_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolution_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_errors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_batches_status_idx" ON "import_batches"("status");

-- CreateIndex
CREATE INDEX "import_batches_uploaded_by_id_idx" ON "import_batches"("uploaded_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "import_batches_organization_id_code_key" ON "import_batches"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "import_batches_organization_id_file_hash_key" ON "import_batches"("organization_id", "file_hash");

-- CreateIndex
CREATE INDEX "import_rows_batch_id_status_idx" ON "import_rows"("batch_id", "status");

-- CreateIndex
CREATE INDEX "import_rows_batch_id_fingerprint_idx" ON "import_rows"("batch_id", "fingerprint");

-- CreateIndex
CREATE INDEX "import_field_mappings_organization_id_source_is_default_idx" ON "import_field_mappings"("organization_id", "source", "is_default");

-- CreateIndex
CREATE UNIQUE INDEX "import_field_mappings_organization_id_source_name_key" ON "import_field_mappings"("organization_id", "source", "name");

-- CreateIndex
CREATE INDEX "import_errors_batch_id_resolved_idx" ON "import_errors"("batch_id", "resolved");

-- CreateIndex
CREATE INDEX "import_errors_batch_id_row_number_idx" ON "import_errors"("batch_id", "row_number");

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_mapped_by_id_fkey" FOREIGN KEY ("mapped_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_validated_by_id_fkey" FOREIGN KEY ("validated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_imported_by_id_fkey" FOREIGN KEY ("imported_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_rolled_back_by_id_fkey" FOREIGN KEY ("rolled_back_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_field_mappings" ADD CONSTRAINT "import_field_mappings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_field_mappings" ADD CONSTRAINT "import_field_mappings_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_field_mappings" ADD CONSTRAINT "import_field_mappings_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_errors" ADD CONSTRAINT "import_errors_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_errors" ADD CONSTRAINT "import_errors_row_id_fkey" FOREIGN KEY ("row_id") REFERENCES "import_rows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_errors" ADD CONSTRAINT "import_errors_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
