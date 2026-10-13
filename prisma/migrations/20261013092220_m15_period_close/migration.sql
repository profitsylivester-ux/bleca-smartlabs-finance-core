-- CreateEnum
CREATE TYPE "CloseItemStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'PASSED', 'FAILED', 'WAIVED', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "CloseItemKey" AS ENUM ('BANK_RECONCILIATION', 'CASH_RECONCILIATION', 'RECEIVABLES', 'PAYABLES', 'MISSING_DOCUMENTS', 'UNAPPROVED_TRANSACTIONS', 'BUDGET_VARIANCES', 'ADJUSTMENTS', 'FINANCIAL_STATEMENTS', 'OPEN_ITEMS_DISCLOSED', 'GO_LIVE_CLEANUP');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'FINANCIAL_CLOSE_STARTED';
ALTER TYPE "AuditAction" ADD VALUE 'FINANCIAL_CLOSE_ITEM_CHECKED';
ALTER TYPE "AuditAction" ADD VALUE 'FINANCIAL_CLOSE_ITEM_WAIVED';
ALTER TYPE "AuditAction" ADD VALUE 'FINANCIAL_CLOSE_SUBMITTED';
ALTER TYPE "AuditAction" ADD VALUE 'FINANCIAL_CLOSE_SIGNED_OFF';
ALTER TYPE "AuditAction" ADD VALUE 'FINANCIAL_CLOSE_REOPEN_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE 'FINANCIAL_CLOSE_REOPEN_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE 'YEAR_END_PROCEDURE_RUN';
ALTER TYPE "AuditAction" ADD VALUE 'ADJUSTMENT_PERIOD_CREATED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEntityType" ADD VALUE 'FINANCIAL_CLOSE';
ALTER TYPE "AuditEntityType" ADD VALUE 'CLOSE_CHECKLIST_ITEM';

-- CreateTable
CREATE TABLE "financial_closes" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "period_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "started_by_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_by_id" TEXT,
    "submitted_at" TIMESTAMP(3),
    "signed_off_by_id" TEXT,
    "signed_off_at" TIMESTAMP(3),
    "approval_request_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "financial_closes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "close_checklist_items" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "close_id" TEXT NOT NULL,
    "item_key" "CloseItemKey" NOT NULL,
    "label" TEXT NOT NULL,
    "is_blocking" BOOLEAN NOT NULL DEFAULT true,
    "is_automated" BOOLEAN NOT NULL DEFAULT false,
    "status" "CloseItemStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "computed_value" TEXT,
    "confirmed_by_id" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "waived_by_id" TEXT,
    "waived_at" TIMESTAMP(3),
    "waiver_reason" TEXT,
    "waiver_approver_id" TEXT,
    "waiver_approved_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "close_checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "financial_closes_organization_id_status_idx" ON "financial_closes"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "financial_closes_period_id_key" ON "financial_closes"("period_id");

-- CreateIndex
CREATE INDEX "close_checklist_items_close_id_status_idx" ON "close_checklist_items"("close_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "close_checklist_items_close_id_item_key_key" ON "close_checklist_items"("close_id", "item_key");

-- AddForeignKey
ALTER TABLE "financial_closes" ADD CONSTRAINT "financial_closes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_closes" ADD CONSTRAINT "financial_closes_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "financial_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_closes" ADD CONSTRAINT "financial_closes_started_by_id_fkey" FOREIGN KEY ("started_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_closes" ADD CONSTRAINT "financial_closes_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_closes" ADD CONSTRAINT "financial_closes_signed_off_by_id_fkey" FOREIGN KEY ("signed_off_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_closes" ADD CONSTRAINT "financial_closes_approval_request_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "approval_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "close_checklist_items" ADD CONSTRAINT "close_checklist_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "close_checklist_items" ADD CONSTRAINT "close_checklist_items_close_id_fkey" FOREIGN KEY ("close_id") REFERENCES "financial_closes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "close_checklist_items" ADD CONSTRAINT "close_checklist_items_confirmed_by_id_fkey" FOREIGN KEY ("confirmed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "close_checklist_items" ADD CONSTRAINT "close_checklist_items_waived_by_id_fkey" FOREIGN KEY ("waived_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "close_checklist_items" ADD CONSTRAINT "close_checklist_items_waiver_approver_id_fkey" FOREIGN KEY ("waiver_approver_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
