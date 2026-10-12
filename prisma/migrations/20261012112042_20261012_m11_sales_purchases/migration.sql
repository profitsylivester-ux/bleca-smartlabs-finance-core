-- CreateEnum
CREATE TYPE "QuotationStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'SENT', 'ACCEPTED', 'EXPIRED', 'CONVERTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InvoiceDirection" AS ENUM ('RECEIVABLE', 'PAYABLE');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'COMPLETED', 'REVERSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentAllocationMode" AS ENUM ('MANUAL', 'AUTOMATIC', 'FIFO');

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('ISSUED', 'VOIDED');

-- CreateEnum
CREATE TYPE "AdjustmentNoteStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'APPLIED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AdjustmentReasonCode" AS ENUM ('RETURN', 'PRICING_ADJUSTMENT', 'DAMAGED_GOODS', 'DUPLICATE_BILLING', 'SERVICE_NOT_RENDERED', 'TAX_ADJUSTMENT', 'OVERCHARGE', 'UNDERCHARGE', 'OTHER');

-- CreateEnum
CREATE TYPE "RecurrenceFrequency" AS ENUM ('MONTHLY', 'QUARTERLY', 'ANNUALLY');

-- CreateEnum
CREATE TYPE "ReminderStatus" AS ENUM ('SCHEDULED', 'SENT', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DocumentSequenceType" AS ENUM ('QUOTATION', 'INVOICE', 'PAYMENT', 'RECEIPT', 'CREDIT_NOTE', 'DEBIT_NOTE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'QUOTATION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'QUOTATION_SUBMITTED';
ALTER TYPE "AuditAction" ADD VALUE 'QUOTATION_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE 'QUOTATION_SENT';
ALTER TYPE "AuditAction" ADD VALUE 'QUOTATION_ACCEPTED';
ALTER TYPE "AuditAction" ADD VALUE 'QUOTATION_EXPIRED';
ALTER TYPE "AuditAction" ADD VALUE 'QUOTATION_CONVERTED';
ALTER TYPE "AuditAction" ADD VALUE 'INVOICE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'INVOICE_SUBMITTED';
ALTER TYPE "AuditAction" ADD VALUE 'INVOICE_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE 'INVOICE_SENT';
ALTER TYPE "AuditAction" ADD VALUE 'INVOICE_CANCELLED';
ALTER TYPE "AuditAction" ADD VALUE 'PAYMENT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'PAYMENT_SUBMITTED';
ALTER TYPE "AuditAction" ADD VALUE 'PAYMENT_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE 'PAYMENT_COMPLETED';
ALTER TYPE "AuditAction" ADD VALUE 'PAYMENT_REVERSED';
ALTER TYPE "AuditAction" ADD VALUE 'PAYMENT_ALLOCATED';
ALTER TYPE "AuditAction" ADD VALUE 'RECEIPT_ISSUED';
ALTER TYPE "AuditAction" ADD VALUE 'RECEIPT_VOIDED';
ALTER TYPE "AuditAction" ADD VALUE 'CREDIT_NOTE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'CREDIT_NOTE_APPLIED';
ALTER TYPE "AuditAction" ADD VALUE 'DEBIT_NOTE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'DEBIT_NOTE_APPLIED';
ALTER TYPE "AuditAction" ADD VALUE 'INVOICE_REMINDER_CREATED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEntityType" ADD VALUE 'QUOTATION';
ALTER TYPE "AuditEntityType" ADD VALUE 'INVOICE';
ALTER TYPE "AuditEntityType" ADD VALUE 'PAYMENT';
ALTER TYPE "AuditEntityType" ADD VALUE 'RECEIPT';
ALTER TYPE "AuditEntityType" ADD VALUE 'CREDIT_NOTE';
ALTER TYPE "AuditEntityType" ADD VALUE 'DEBIT_NOTE';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JournalSource" ADD VALUE 'CREDIT_NOTE';
ALTER TYPE "JournalSource" ADD VALUE 'DEBIT_NOTE';

-- AlterEnum
ALTER TYPE "ModuleKey" ADD VALUE 'DEBIT_NOTES';

-- CreateTable
CREATE TABLE "quotations" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "QuotationStatus" NOT NULL DEFAULT 'DRAFT',
    "quote_date" DATE NOT NULL,
    "valid_until" DATE NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "subtotal" DECIMAL(20,6) NOT NULL,
    "tax_amount" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(20,6) NOT NULL,
    "submitted_by_id" TEXT,
    "submitted_at" TIMESTAMP(3),
    "approved_by_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "accepted_at" TIMESTAMP(3),
    "converted_at" TIMESTAMP(3),
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_lines" (
    "id" TEXT NOT NULL,
    "quotation_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,
    "unit_price" DECIMAL(20,6) NOT NULL,
    "amount" DECIMAL(20,6) NOT NULL,
    "invoiced_quantity" DECIMAL(20,6) NOT NULL DEFAULT 0,

    CONSTRAINT "quotation_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "direction" "InvoiceDirection" NOT NULL,
    "customer_id" TEXT,
    "supplier_id" TEXT,
    "quotation_id" TEXT,
    "number" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "invoice_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "subtotal" DECIMAL(20,6) NOT NULL,
    "tax_amount" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(20,6) NOT NULL,
    "tax_invoice_number" TEXT,
    "is_tax_invoice" BOOLEAN NOT NULL DEFAULT false,
    "journal_entry_id" TEXT,
    "reversal_journal_entry_id" TEXT,
    "submitted_by_id" TEXT,
    "submitted_at" TIMESTAMP(3),
    "approved_by_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancellation_reason" TEXT,
    "recurrence_frequency" "RecurrenceFrequency",
    "recurrence_next_at" DATE,
    "recurrence_ends_at" DATE,
    "recurrence_template_id" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "quotation_line_id" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,
    "unit_price" DECIMAL(20,6) NOT NULL,
    "amount" DECIMAL(20,6) NOT NULL,
    "tax_rate" DECIMAL(9,6),
    "tax_amount" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "tax_account_id" TEXT,
    "account_id" TEXT NOT NULL,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_reminders" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "status" "ReminderStatus" NOT NULL DEFAULT 'SCHEDULED',
    "recipient" TEXT,
    "message" TEXT NOT NULL,
    "scheduled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_sequences" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "type" "DocumentSequenceType" NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "direction" "PaymentDirection" NOT NULL,
    "customer_id" TEXT,
    "supplier_id" TEXT,
    "number" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'DRAFT',
    "treasury_account_id" TEXT NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "amount" DECIMAL(20,6) NOT NULL,
    "unapplied_amount" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "allocation_mode" "PaymentAllocationMode" NOT NULL DEFAULT 'FIFO',
    "on_account_account_id" TEXT,
    "payment_date" DATE NOT NULL,
    "reference" TEXT,
    "description" TEXT,
    "journal_entry_id" TEXT,
    "reversal_journal_entry_id" TEXT,
    "submitted_by_id" TEXT,
    "submitted_at" TIMESTAMP(3),
    "approved_by_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_method_lines" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" DECIMAL(20,6) NOT NULL,
    "reference" TEXT,

    CONSTRAINT "payment_method_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "amount" DECIMAL(20,6) NOT NULL,
    "allocated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "ReceiptStatus" NOT NULL DEFAULT 'ISSUED',
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supporting_document_id" TEXT,
    "voided_at" TIMESTAMP(3),
    "void_reason" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_lines" (
    "id" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "amount" DECIMAL(20,6) NOT NULL,

    CONSTRAINT "receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_notes" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "AdjustmentNoteStatus" NOT NULL DEFAULT 'DRAFT',
    "reason_code" "AdjustmentReasonCode" NOT NULL,
    "reason" TEXT NOT NULL,
    "amount" DECIMAL(20,6) NOT NULL,
    "tax_amount" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "journal_entry_id" TEXT,
    "created_by_id" TEXT NOT NULL,
    "approved_by_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "applied_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debit_notes" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "AdjustmentNoteStatus" NOT NULL DEFAULT 'DRAFT',
    "reason_code" "AdjustmentReasonCode" NOT NULL,
    "reason" TEXT NOT NULL,
    "amount" DECIMAL(20,6) NOT NULL,
    "tax_amount" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "journal_entry_id" TEXT,
    "created_by_id" TEXT NOT NULL,
    "approved_by_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "applied_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "debit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quotations_organization_id_customer_id_status_valid_until_idx" ON "quotations"("organization_id", "customer_id", "status", "valid_until");

-- CreateIndex
CREATE UNIQUE INDEX "quotations_organization_id_number_key" ON "quotations"("organization_id", "number");

-- CreateIndex
CREATE INDEX "quotation_lines_quotation_id_idx" ON "quotation_lines"("quotation_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_journal_entry_id_key" ON "invoices"("journal_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_reversal_journal_entry_id_key" ON "invoices"("reversal_journal_entry_id");

-- CreateIndex
CREATE INDEX "invoices_organization_id_direction_status_due_date_idx" ON "invoices"("organization_id", "direction", "status", "due_date");

-- CreateIndex
CREATE INDEX "invoices_organization_id_customer_id_invoice_date_idx" ON "invoices"("organization_id", "customer_id", "invoice_date");

-- CreateIndex
CREATE INDEX "invoices_organization_id_supplier_id_invoice_date_idx" ON "invoices"("organization_id", "supplier_id", "invoice_date");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_organization_id_number_key" ON "invoices"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_organization_id_tax_invoice_number_key" ON "invoices"("organization_id", "tax_invoice_number");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_organization_id_recurrence_template_id_invoice_dat_key" ON "invoices"("organization_id", "recurrence_template_id", "invoice_date");

-- CreateIndex
CREATE INDEX "invoice_lines_invoice_id_idx" ON "invoice_lines"("invoice_id");

-- CreateIndex
CREATE INDEX "invoice_lines_quotation_line_id_idx" ON "invoice_lines"("quotation_line_id");

-- CreateIndex
CREATE INDEX "invoice_reminders_organization_id_status_scheduled_at_idx" ON "invoice_reminders"("organization_id", "status", "scheduled_at");

-- CreateIndex
CREATE INDEX "invoice_reminders_invoice_id_scheduled_at_idx" ON "invoice_reminders"("invoice_id", "scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "document_sequences_organization_id_type_key" ON "document_sequences"("organization_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "payments_journal_entry_id_key" ON "payments"("journal_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_reversal_journal_entry_id_key" ON "payments"("reversal_journal_entry_id");

-- CreateIndex
CREATE INDEX "payments_organization_id_direction_status_payment_date_idx" ON "payments"("organization_id", "direction", "status", "payment_date");

-- CreateIndex
CREATE INDEX "payments_organization_id_customer_id_payment_date_idx" ON "payments"("organization_id", "customer_id", "payment_date");

-- CreateIndex
CREATE INDEX "payments_organization_id_supplier_id_payment_date_idx" ON "payments"("organization_id", "supplier_id", "payment_date");

-- CreateIndex
CREATE UNIQUE INDEX "payments_organization_id_number_key" ON "payments"("organization_id", "number");

-- CreateIndex
CREATE INDEX "payment_method_lines_payment_id_idx" ON "payment_method_lines"("payment_id");

-- CreateIndex
CREATE INDEX "payment_allocations_invoice_id_allocated_at_idx" ON "payment_allocations"("invoice_id", "allocated_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_allocations_payment_id_invoice_id_key" ON "payment_allocations"("payment_id", "invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_payment_id_key" ON "receipts"("payment_id");

-- CreateIndex
CREATE INDEX "receipts_organization_id_issued_at_idx" ON "receipts"("organization_id", "issued_at");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_organization_id_number_key" ON "receipts"("organization_id", "number");

-- CreateIndex
CREATE INDEX "receipt_lines_receipt_id_idx" ON "receipt_lines"("receipt_id");

-- CreateIndex
CREATE INDEX "receipt_lines_invoice_id_idx" ON "receipt_lines"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_journal_entry_id_key" ON "credit_notes"("journal_entry_id");

-- CreateIndex
CREATE INDEX "credit_notes_organization_id_status_created_at_idx" ON "credit_notes"("organization_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "credit_notes_invoice_id_idx" ON "credit_notes"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_organization_id_number_key" ON "credit_notes"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "debit_notes_journal_entry_id_key" ON "debit_notes"("journal_entry_id");

-- CreateIndex
CREATE INDEX "debit_notes_organization_id_status_created_at_idx" ON "debit_notes"("organization_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "debit_notes_invoice_id_idx" ON "debit_notes"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "debit_notes_organization_id_number_key" ON "debit_notes"("organization_id", "number");

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_recurrence_template_id_fkey" FOREIGN KEY ("recurrence_template_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_quotation_line_id_fkey" FOREIGN KEY ("quotation_line_id") REFERENCES "quotation_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_reminders" ADD CONSTRAINT "invoice_reminders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_reminders" ADD CONSTRAINT "invoice_reminders_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_treasury_account_id_fkey" FOREIGN KEY ("treasury_account_id") REFERENCES "treasury_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_method_lines" ADD CONSTRAINT "payment_method_lines_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_lines" ADD CONSTRAINT "receipt_lines_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_lines" ADD CONSTRAINT "receipt_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
