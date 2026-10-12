-- CreateEnum
CREATE TYPE "PartyKind" AS ENUM ('INDIVIDUAL', 'COMPANY');

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('PROSPECT', 'ACTIVE', 'INACTIVE', 'CREDIT_HOLD', 'BLOCKED');

-- CreateEnum
CREATE TYPE "SupplierStatus" AS ENUM ('PROSPECT', 'ACTIVE', 'INACTIVE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "PartyRiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "PartyAddressType" AS ENUM ('REGISTERED', 'BILLING', 'SHIPPING', 'OTHER');

-- CreateEnum
CREATE TYPE "CommunicationChannel" AS ENUM ('EMAIL', 'PHONE', 'MEETING', 'LETTER', 'OTHER');

-- CreateEnum
CREATE TYPE "CommunicationDirection" AS ENUM ('INBOUND', 'OUTBOUND', 'INTERNAL');

-- CreateEnum
CREATE TYPE "BankDetailChangeStatus" AS ENUM ('PENDING', 'VERIFICATION_PENDING', 'APPROVAL_PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CustomerReceivableStatus" AS ENUM ('OPEN', 'PARTIALLY_PAID', 'PAID', 'WRITTEN_OFF', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CustomerCreditHoldStatus" AS ENUM ('ACTIVE', 'RELEASED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'CUSTOMER_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'CUSTOMER_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'CUSTOMER_DEACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'CUSTOMER_CREDIT_HOLD';
ALTER TYPE "AuditAction" ADD VALUE 'CUSTOMER_CREDIT_HOLD_RELEASED';
ALTER TYPE "AuditAction" ADD VALUE 'CUSTOMER_CREDIT_LIMIT_EXCEEDED';
ALTER TYPE "AuditAction" ADD VALUE 'SUPPLIER_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'SUPPLIER_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'SUPPLIER_DEACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'SUPPLIER_BANK_DETAIL_CHANGE_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE 'SUPPLIER_BANK_DETAIL_CHANGE_VERIFIED';
ALTER TYPE "AuditAction" ADD VALUE 'SUPPLIER_BANK_DETAIL_CHANGE_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE 'SUPPLIER_BANK_DETAIL_CHANGE_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE 'COMMUNICATION_LOG_CREATED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEntityType" ADD VALUE 'PARTY';
ALTER TYPE "AuditEntityType" ADD VALUE 'CUSTOMER';
ALTER TYPE "AuditEntityType" ADD VALUE 'SUPPLIER';
ALTER TYPE "AuditEntityType" ADD VALUE 'CONTACT';
ALTER TYPE "AuditEntityType" ADD VALUE 'PARTY_ADDRESS';
ALTER TYPE "AuditEntityType" ADD VALUE 'COMMUNICATION_LOG';
ALTER TYPE "AuditEntityType" ADD VALUE 'SUPPLIER_BANK_DETAIL';
ALTER TYPE "AuditEntityType" ADD VALUE 'SUPPLIER_BANK_DETAIL_CHANGE_REQUEST';
ALTER TYPE "AuditEntityType" ADD VALUE 'CUSTOMER_CREDIT_HOLD';
ALTER TYPE "AuditEntityType" ADD VALUE 'CUSTOMER_RECEIVABLE';

-- CreateTable
CREATE TABLE "parties" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "PartyKind" NOT NULL,
    "display_name" TEXT NOT NULL,
    "legal_name" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "tax_identifier" TEXT,
    "registration_number" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" TEXT,
    "updated_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "parties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "party_id" TEXT NOT NULL,
    "status" "CustomerStatus" NOT NULL DEFAULT 'PROSPECT',
    "master_data_status" "MasterDataStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "payment_terms_days" INTEGER NOT NULL DEFAULT 30,
    "credit_limit" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "currency_code" CHAR(3) NOT NULL DEFAULT 'TZS',
    "relationship_owner_id" TEXT,
    "risk_level" "PartyRiskLevel" NOT NULL DEFAULT 'MEDIUM',
    "credit_hold_reason" TEXT,
    "credit_held_at" TIMESTAMP(3),
    "bad_debt_amount" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "created_by_id" TEXT,
    "updated_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "party_id" TEXT NOT NULL,
    "status" "SupplierStatus" NOT NULL DEFAULT 'PROSPECT',
    "master_data_status" "MasterDataStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "payment_terms_days" INTEGER NOT NULL DEFAULT 30,
    "payment_currency_code" CHAR(3),
    "performance_rating" DECIMAL(4,2),
    "delivery_rating" DECIMAL(4,2),
    "quality_rating" DECIMAL(4,2),
    "risk_level" "PartyRiskLevel" NOT NULL DEFAULT 'MEDIUM',
    "created_by_id" TEXT,
    "updated_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "party_id" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "title" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "party_addresses" (
    "id" TEXT NOT NULL,
    "party_id" TEXT NOT NULL,
    "type" "PartyAddressType" NOT NULL,
    "label" TEXT,
    "address_line_1" TEXT NOT NULL,
    "address_line_2" TEXT,
    "city" TEXT,
    "region" TEXT,
    "postal_code" TEXT,
    "country_code" CHAR(2) NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "party_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communication_logs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "party_id" TEXT NOT NULL,
    "channel" "CommunicationChannel" NOT NULL,
    "direction" "CommunicationDirection" NOT NULL DEFAULT 'OUTBOUND',
    "subject" TEXT,
    "summary" TEXT NOT NULL,
    "contacted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "follow_up_at" TIMESTAMP(3),
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "communication_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_bank_details" (
    "id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "bank_name" TEXT NOT NULL,
    "account_holder_name" TEXT NOT NULL,
    "account_number_encrypted" TEXT NOT NULL,
    "account_number_last4" VARCHAR(4) NOT NULL,
    "branch_name" TEXT,
    "swift_code" TEXT,
    "iban" TEXT,
    "currency_code" CHAR(3),
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_bank_details_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_bank_detail_change_requests" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "current_bank_detail_id" TEXT,
    "previous_values" JSONB NOT NULL,
    "proposed_values" JSONB NOT NULL,
    "evidence_document_id" TEXT NOT NULL,
    "status" "BankDetailChangeStatus" NOT NULL DEFAULT 'PENDING',
    "requested_by_id" TEXT NOT NULL,
    "verifier_id" TEXT,
    "approver_id" TEXT,
    "rejected_by_id" TEXT,
    "verification_notes" TEXT,
    "decision_reason" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified_at" TIMESTAMP(3),
    "decided_at" TIMESTAMP(3),
    "applied_bank_detail_id" TEXT,

    CONSTRAINT "supplier_bank_detail_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_products_services" (
    "id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "product_service_id" TEXT NOT NULL,
    "supplier_item_code" TEXT,
    "unit_price" DECIMAL(20,6),
    "currency_code" CHAR(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_products_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_tax_obligation_links" (
    "id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "tax_obligation_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_tax_obligation_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_credit_holds" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "status" "CustomerCreditHoldStatus" NOT NULL DEFAULT 'ACTIVE',
    "reason" TEXT NOT NULL,
    "requested_by_id" TEXT NOT NULL,
    "held_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "release_reason" TEXT,
    "released_by_id" TEXT,
    "released_at" TIMESTAMP(3),

    CONSTRAINT "customer_credit_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_receivables" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "invoice_id" TEXT,
    "invoice_reference" TEXT NOT NULL,
    "source_journal_entry_id" TEXT,
    "currency_code" CHAR(3) NOT NULL,
    "original_amount" DECIMAL(20,6) NOT NULL,
    "outstanding_amount" DECIMAL(20,6) NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "status" "CustomerReceivableStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_receivables_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "parties_organization_id_kind_display_name_idx" ON "parties"("organization_id", "kind", "display_name");

-- CreateIndex
CREATE INDEX "parties_organization_id_deleted_at_idx" ON "parties"("organization_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "parties_organization_id_code_key" ON "parties"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "customers_party_id_key" ON "customers"("party_id");

-- CreateIndex
CREATE INDEX "customers_organization_id_status_master_data_status_idx" ON "customers"("organization_id", "status", "master_data_status");

-- CreateIndex
CREATE INDEX "customers_organization_id_relationship_owner_id_idx" ON "customers"("organization_id", "relationship_owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_party_id_key" ON "suppliers"("party_id");

-- CreateIndex
CREATE INDEX "suppliers_organization_id_status_master_data_status_idx" ON "suppliers"("organization_id", "status", "master_data_status");

-- CreateIndex
CREATE INDEX "contacts_party_id_is_primary_idx" ON "contacts"("party_id", "is_primary");

-- CreateIndex
CREATE INDEX "party_addresses_party_id_type_idx" ON "party_addresses"("party_id", "type");

-- CreateIndex
CREATE INDEX "communication_logs_organization_id_party_id_contacted_at_idx" ON "communication_logs"("organization_id", "party_id", "contacted_at");

-- CreateIndex
CREATE INDEX "communication_logs_organization_id_follow_up_at_idx" ON "communication_logs"("organization_id", "follow_up_at");

-- CreateIndex
CREATE INDEX "supplier_bank_details_supplier_id_is_active_is_primary_idx" ON "supplier_bank_details"("supplier_id", "is_active", "is_primary");

-- CreateIndex
CREATE INDEX "supplier_bank_detail_change_requests_organization_id_suppli_idx" ON "supplier_bank_detail_change_requests"("organization_id", "supplier_id", "status");

-- CreateIndex
CREATE INDEX "supplier_bank_detail_change_requests_supplier_id_requested__idx" ON "supplier_bank_detail_change_requests"("supplier_id", "requested_at");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_products_services_supplier_id_product_service_id_key" ON "supplier_products_services"("supplier_id", "product_service_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_tax_obligation_links_supplier_id_tax_obligation_id_key" ON "supplier_tax_obligation_links"("supplier_id", "tax_obligation_id");

-- CreateIndex
CREATE INDEX "customer_credit_holds_customer_id_status_held_at_idx" ON "customer_credit_holds"("customer_id", "status", "held_at");

-- CreateIndex
CREATE INDEX "customer_receivables_organization_id_customer_id_status_due_idx" ON "customer_receivables"("organization_id", "customer_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "customer_receivables_organization_id_invoice_id_idx" ON "customer_receivables"("organization_id", "invoice_id");

-- AddForeignKey
ALTER TABLE "parties" ADD CONSTRAINT "parties_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_addresses" ADD CONSTRAINT "party_addresses_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_logs" ADD CONSTRAINT "communication_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_logs" ADD CONSTRAINT "communication_logs_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bank_details" ADD CONSTRAINT "supplier_bank_details_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bank_detail_change_requests" ADD CONSTRAINT "supplier_bank_detail_change_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bank_detail_change_requests" ADD CONSTRAINT "supplier_bank_detail_change_requests_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_products_services" ADD CONSTRAINT "supplier_products_services_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_products_services" ADD CONSTRAINT "supplier_products_services_product_service_id_fkey" FOREIGN KEY ("product_service_id") REFERENCES "products_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_tax_obligation_links" ADD CONSTRAINT "supplier_tax_obligation_links_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_credit_holds" ADD CONSTRAINT "customer_credit_holds_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_receivables" ADD CONSTRAINT "customer_receivables_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_receivables" ADD CONSTRAINT "customer_receivables_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
