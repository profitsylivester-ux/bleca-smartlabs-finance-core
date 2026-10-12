-- CreateEnum
CREATE TYPE "TaxRuleType" AS ENUM ('VAT', 'WITHHOLDING', 'INCOME_TAX', 'TURNOVER_TAX', 'FILING_FEE', 'STAMP_DUTY', 'OTHER');

-- CreateEnum
CREATE TYPE "TaxCalculationBasis" AS ENUM ('EXCLUSIVE', 'INCLUSIVE', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "TaxRoundingMode" AS ENUM ('HALF_UP', 'HALF_DOWN', 'HALF_EVEN', 'UP', 'DOWN');

-- CreateEnum
CREATE TYPE "TaxObligationDirection" AS ENUM ('OUTPUT', 'INPUT', 'WITHHELD', 'PAYABLE');

-- CreateEnum
CREATE TYPE "TaxObligationStatus" AS ENUM ('PENDING', 'FILED', 'PAID', 'OVERDUE', 'EXEMPT', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "CredentialType" AS ENUM ('REGISTRATION', 'TIN_CERTIFICATE', 'LICENCE', 'PERMIT', 'CERTIFICATION', 'MEMBERSHIP', 'DOMAIN', 'INSURANCE', 'SOFTWARE_SUBSCRIPTION', 'OTHER');

-- CreateEnum
CREATE TYPE "CredentialStatus" AS ENUM ('PENDING', 'ACTIVE', 'EXPIRING_SOON', 'EXPIRED', 'REVOKED', 'NOT_APPLICABLE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'TAX_RULE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'TAX_RULE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'TAX_RULE_DEACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'TAX_OBLIGATION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'TAX_OBLIGATION_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'TAX_OBLIGATION_FILED';
ALTER TYPE "AuditAction" ADD VALUE 'TAX_OBLIGATION_PAID';
ALTER TYPE "AuditAction" ADD VALUE 'TAX_PAYMENT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'TAX_PAYMENT_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'TAX_PAYMENT_DELETED';
ALTER TYPE "AuditAction" ADD VALUE 'TAX_INVOICE_ISSUED';
ALTER TYPE "AuditAction" ADD VALUE 'CREDENTIAL_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'CREDENTIAL_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'CREDENTIAL_DELETED';
ALTER TYPE "AuditAction" ADD VALUE 'COMPLIANCE_DOCUMENT_LINKED';
ALTER TYPE "AuditAction" ADD VALUE 'COMPLIANCE_DOCUMENT_UNLINKED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEntityType" ADD VALUE 'TAX_RULE';
ALTER TYPE "AuditEntityType" ADD VALUE 'TAX_OBLIGATION';
ALTER TYPE "AuditEntityType" ADD VALUE 'TAX_PAYMENT';
ALTER TYPE "AuditEntityType" ADD VALUE 'TAX_INVOICE';
ALTER TYPE "AuditEntityType" ADD VALUE 'CREDENTIAL';
ALTER TYPE "AuditEntityType" ADD VALUE 'COMPLIANCE_DOCUMENT';

-- AlterEnum
ALTER TYPE "NotificationCategory" ADD VALUE 'COMPLIANCE_EXPIRY';

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "tax_invoice_valid" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tax_rules_applied" JSONB;

-- CreateTable
CREATE TABLE "tax_rules" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "TaxRuleType" NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "rate_percent" DECIMAL(9,6),
    "is_inclusive" BOOLEAN NOT NULL DEFAULT false,
    "calculation_basis" "TaxCalculationBasis" NOT NULL,
    "applies_when_organization_registered" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "payable_account_id" TEXT,
    "receivable_account_id" TEXT,
    "rounding_mode" "TaxRoundingMode" NOT NULL DEFAULT 'HALF_UP',
    "min_taxable_amount" DECIMAL(20,6),
    "exemption_threshold" DECIMAL(20,6),
    "verified_by_professional_on" DATE,
    "verified_by_professional_name" TEXT,
    "verification_reference" TEXT,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_obligations" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "tax_rule_id" TEXT,
    "period" TEXT NOT NULL,
    "direction" "TaxObligationDirection" NOT NULL,
    "status" "TaxObligationStatus" NOT NULL DEFAULT 'PENDING',
    "filing_due_date" DATE,
    "filed_at" TIMESTAMP(3),
    "taxable_amount" DECIMAL(20,6) NOT NULL,
    "tax_amount" DECIMAL(20,6) NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "description" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_obligations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_payments" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "obligation_id" TEXT NOT NULL,
    "paid_at" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(20,6) NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "reference" TEXT,
    "document_id" TEXT,
    "journal_entry_id" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credentials" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "type" "CredentialType" NOT NULL,
    "title" TEXT NOT NULL,
    "issuing_authority" TEXT,
    "registration_number" TEXT,
    "issued_date" DATE,
    "expiry_date" DATE,
    "responsible_user_id" TEXT NOT NULL,
    "cost" DECIMAL(20,6),
    "currency_code" CHAR(3),
    "status" "CredentialStatus" NOT NULL DEFAULT 'ACTIVE',
    "renewal_reminder_days" INTEGER NOT NULL DEFAULT 30,
    "document_id" TEXT,
    "notes" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_documents" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "credential_id" TEXT,
    "obligation_id" TEXT,
    "notes" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_invoice_sequences" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT '',
    "suffix" TEXT NOT NULL DEFAULT '',
    "padding" INTEGER NOT NULL DEFAULT 0,
    "next_number" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_invoice_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tax_rules_organization_id_is_active_effective_from_effectiv_idx" ON "tax_rules"("organization_id", "is_active", "effective_from", "effective_to");

-- CreateIndex
CREATE UNIQUE INDEX "tax_rules_organization_id_code_key" ON "tax_rules"("organization_id", "code");

-- CreateIndex
CREATE INDEX "tax_obligations_organization_id_status_filing_due_date_idx" ON "tax_obligations"("organization_id", "status", "filing_due_date");

-- CreateIndex
CREATE INDEX "tax_obligations_organization_id_tax_rule_id_period_idx" ON "tax_obligations"("organization_id", "tax_rule_id", "period");

-- CreateIndex
CREATE UNIQUE INDEX "tax_payments_journal_entry_id_key" ON "tax_payments"("journal_entry_id");

-- CreateIndex
CREATE INDEX "tax_payments_organization_id_obligation_id_paid_at_idx" ON "tax_payments"("organization_id", "obligation_id", "paid_at");

-- CreateIndex
CREATE INDEX "credentials_organization_id_status_expiry_date_idx" ON "credentials"("organization_id", "status", "expiry_date");

-- CreateIndex
CREATE INDEX "credentials_responsible_user_id_idx" ON "credentials"("responsible_user_id");

-- CreateIndex
CREATE INDEX "compliance_documents_organization_id_document_id_idx" ON "compliance_documents"("organization_id", "document_id");

-- CreateIndex
CREATE INDEX "compliance_documents_organization_id_credential_id_idx" ON "compliance_documents"("organization_id", "credential_id");

-- CreateIndex
CREATE INDEX "compliance_documents_organization_id_obligation_id_idx" ON "compliance_documents"("organization_id", "obligation_id");

-- CreateIndex
CREATE UNIQUE INDEX "tax_invoice_sequences_organization_id_key" ON "tax_invoice_sequences"("organization_id");

-- AddForeignKey
ALTER TABLE "tax_rules" ADD CONSTRAINT "tax_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rules" ADD CONSTRAINT "tax_rules_payable_account_id_fkey" FOREIGN KEY ("payable_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rules" ADD CONSTRAINT "tax_rules_receivable_account_id_fkey" FOREIGN KEY ("receivable_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_obligations" ADD CONSTRAINT "tax_obligations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_obligations" ADD CONSTRAINT "tax_obligations_tax_rule_id_fkey" FOREIGN KEY ("tax_rule_id") REFERENCES "tax_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_payments" ADD CONSTRAINT "tax_payments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_payments" ADD CONSTRAINT "tax_payments_obligation_id_fkey" FOREIGN KEY ("obligation_id") REFERENCES "tax_obligations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_payments" ADD CONSTRAINT "tax_payments_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_payments" ADD CONSTRAINT "tax_payments_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_responsible_user_id_fkey" FOREIGN KEY ("responsible_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_documents" ADD CONSTRAINT "compliance_documents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_documents" ADD CONSTRAINT "compliance_documents_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_documents" ADD CONSTRAINT "compliance_documents_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_documents" ADD CONSTRAINT "compliance_documents_obligation_id_fkey" FOREIGN KEY ("obligation_id") REFERENCES "tax_obligations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_invoice_sequences" ADD CONSTRAINT "tax_invoice_sequences_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
