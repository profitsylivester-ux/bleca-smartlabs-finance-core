-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEntityType" ADD VALUE 'REASON_CODE';
ALTER TYPE "AuditEntityType" ADD VALUE 'PRODUCT_SERVICE';

-- CreateTable
CREATE TABLE "reason_codes" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reason_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products_services" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "unit" TEXT,
    "unit_price" DECIMAL(20,6),
    "currency_id" CHAR(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_services_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reason_codes_category_is_active_idx" ON "reason_codes"("category", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "reason_codes_organization_id_code_key" ON "reason_codes"("organization_id", "code");

-- CreateIndex
CREATE INDEX "products_services_type_is_active_idx" ON "products_services"("type", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "products_services_organization_id_code_key" ON "products_services"("organization_id", "code");

-- AddForeignKey
ALTER TABLE "reason_codes" ADD CONSTRAINT "reason_codes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products_services" ADD CONSTRAINT "products_services_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products_services" ADD CONSTRAINT "products_services_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currencies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
