-- CreateEnum
CREATE TYPE "ReconciliationTarget" AS ENUM ('BANK_STATEMENT', 'LEDGER', 'MOBILE_MONEY', 'PAYMENT_GATEWAY', 'CASH');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'MATCHED', 'AWAITING_APPROVAL', 'APPROVED', 'LOCKED', 'REOPENED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MatchType" AS ENUM ('EXACT', 'DATE_WINDOW', 'AMOUNT_TOLERANCE', 'REFERENCE_SIMILARITY', 'ONE_TO_MANY', 'MANY_TO_ONE', 'MANUAL');

-- CreateEnum
CREATE TYPE "ReconciliationLineStatus" AS ENUM ('PROPOSED', 'MATCHED', 'REJECTED', 'EXCEPTION', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ReconciliationExceptionType" AS ENUM ('UNMATCHED_STATEMENT_LINE', 'UNMATCHED_LEDGER_ENTRY', 'AMOUNT_DIFFERENCE', 'DATE_DIFFERENCE', 'DUPLICATE_SUSPECTED', 'LOW_CONFIDENCE', 'UNSUPPORTED_ITEM', 'TIMING_DIFFERENCE');

-- CreateEnum
CREATE TYPE "ReconciliationExceptionStatus" AS ENUM ('OPEN', 'RESOLVED', 'WAIVED');

-- CreateEnum
CREATE TYPE "ReconciliationAdjustmentStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED', 'REJECTED', 'REVERSED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'IMPORT_UPLOADED';
ALTER TYPE "AuditAction" ADD VALUE 'IMPORT_MAPPING_SAVED';
ALTER TYPE "AuditAction" ADD VALUE 'IMPORT_VALIDATED';
ALTER TYPE "AuditAction" ADD VALUE 'IMPORT_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE 'IMPORT_EXECUTED';
ALTER TYPE "AuditAction" ADD VALUE 'IMPORT_ROLLED_BACK';
ALTER TYPE "AuditAction" ADD VALUE 'IMPORT_ROW_ERROR';
ALTER TYPE "AuditAction" ADD VALUE 'IMPORT_ERROR_RESOLVED';
ALTER TYPE "AuditAction" ADD VALUE 'RECONCILIATION_SESSION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'RECONCILIATION_AUTO_MATCHED';
ALTER TYPE "AuditAction" ADD VALUE 'RECONCILIATION_MATCH_CONFIRMED';
ALTER TYPE "AuditAction" ADD VALUE 'RECONCILIATION_MATCH_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE 'RECONCILIATION_EXCEPTION_RESOLVED';
ALTER TYPE "AuditAction" ADD VALUE 'RECONCILIATION_ADJUSTMENT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'RECONCILIATION_ADJUSTMENT_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE 'RECONCILIATION_ADJUSTMENT_POSTED';
ALTER TYPE "AuditAction" ADD VALUE 'RECONCILIATION_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE 'RECONCILIATION_REOPENED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEntityType" ADD VALUE 'IMPORT_BATCH';
ALTER TYPE "AuditEntityType" ADD VALUE 'IMPORT_ROW';
ALTER TYPE "AuditEntityType" ADD VALUE 'IMPORT_FIELD_MAPPING';
ALTER TYPE "AuditEntityType" ADD VALUE 'IMPORT_ERROR';
ALTER TYPE "AuditEntityType" ADD VALUE 'RECONCILIATION_SESSION';
ALTER TYPE "AuditEntityType" ADD VALUE 'RECONCILIATION_MATCH';
ALTER TYPE "AuditEntityType" ADD VALUE 'RECONCILIATION_EXCEPTION';
ALTER TYPE "AuditEntityType" ADD VALUE 'RECONCILIATION_ADJUSTMENT';
ALTER TYPE "AuditEntityType" ADD VALUE 'MATCHING_RULE';

-- CreateTable
CREATE TABLE "matching_rules" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "ruleType" "MatchType" NOT NULL,
    "target" "ReconciliationTarget" NOT NULL,
    "date_window_days" INTEGER NOT NULL DEFAULT 3,
    "amount_tolerance" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "similarity_threshold" INTEGER NOT NULL DEFAULT 80,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "matching_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_sessions" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "treasury_account_id" TEXT NOT NULL,
    "import_id" TEXT,
    "period_id" TEXT,
    "code" TEXT NOT NULL,
    "target" "ReconciliationTarget" NOT NULL,
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "statement_start_date" DATE,
    "statement_end_date" DATE,
    "statement_opening_balance" DECIMAL(20,6),
    "statement_closing_balance" DECIMAL(20,6),
    "book_balance_beginning" DECIMAL(20,6),
    "book_balance_ending" DECIMAL(20,6),
    "calculated_ending_balance" DECIMAL(20,6),
    "difference" DECIMAL(20,6),
    "currency" CHAR(3) NOT NULL,
    "matching_rules_applied" JSONB,
    "auto_match_threshold" INTEGER NOT NULL DEFAULT 85,
    "started_by_id" TEXT,
    "startedAt" TIMESTAMP(3),
    "reviewed_by_id" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "approved_by_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "locked_at" TIMESTAMP(3),
    "reopened_at" TIMESTAMP(3),
    "reopen_reason" TEXT,
    "reopen_count" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reconciliation_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_matches" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "match_group_id" TEXT,
    "import_row_id" TEXT,
    "transaction_id" TEXT,
    "journal_entry_id" TEXT,
    "matchType" "MatchType" NOT NULL DEFAULT 'MANUAL',
    "status" "ReconciliationLineStatus" NOT NULL DEFAULT 'PROPOSED',
    "statement_amount" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "ledger_amount" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "matched_amount" DECIMAL(20,6) NOT NULL,
    "difference_amount" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "confidence" INTEGER,
    "matched_rule_id" TEXT,
    "difference_reason" TEXT,
    "is_manual" BOOLEAN NOT NULL DEFAULT false,
    "matched_by_id" TEXT,
    "matched_at" TIMESTAMP(3),
    "confirmed_by_id" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "rejected_by_id" TEXT,
    "rejected_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reconciliation_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_exceptions" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "import_row_id" TEXT,
    "transaction_id" TEXT,
    "exception_type" "ReconciliationExceptionType" NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "amount" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL,
    "suggested_resolution" TEXT,
    "confidence" INTEGER,
    "status" "ReconciliationExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "resolved_by_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reconciliation_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_adjustments" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "debit" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "credit" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "status" "ReconciliationAdjustmentStatus" NOT NULL DEFAULT 'DRAFT',
    "reason_code_id" TEXT NOT NULL,
    "approval_request_id" TEXT,
    "journal_entry_id" TEXT,
    "document_id" TEXT,
    "posted_by_id" TEXT,
    "posted_at" TIMESTAMP(3),
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reconciliation_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "matching_rules_organization_id_target_is_active_priority_idx" ON "matching_rules"("organization_id", "target", "is_active", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "matching_rules_organization_id_name_key" ON "matching_rules"("organization_id", "name");

-- CreateIndex
CREATE INDEX "reconciliation_sessions_status_idx" ON "reconciliation_sessions"("status");

-- CreateIndex
CREATE INDEX "reconciliation_sessions_period_id_idx" ON "reconciliation_sessions"("period_id");

-- CreateIndex
CREATE INDEX "reconciliation_sessions_treasury_account_id_idx" ON "reconciliation_sessions"("treasury_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_sessions_organization_id_code_key" ON "reconciliation_sessions"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_sessions_organization_id_treasury_account_id_key" ON "reconciliation_sessions"("organization_id", "treasury_account_id", "statement_start_date", "statement_end_date");

-- CreateIndex
CREATE INDEX "reconciliation_matches_session_id_status_idx" ON "reconciliation_matches"("session_id", "status");

-- CreateIndex
CREATE INDEX "reconciliation_matches_session_id_match_group_id_idx" ON "reconciliation_matches"("session_id", "match_group_id");

-- CreateIndex
CREATE INDEX "reconciliation_matches_import_row_id_idx" ON "reconciliation_matches"("import_row_id");

-- CreateIndex
CREATE INDEX "reconciliation_matches_transaction_id_idx" ON "reconciliation_matches"("transaction_id");

-- CreateIndex
CREATE INDEX "reconciliation_matches_journal_entry_id_idx" ON "reconciliation_matches"("journal_entry_id");

-- CreateIndex
CREATE INDEX "reconciliation_exceptions_session_id_status_idx" ON "reconciliation_exceptions"("session_id", "status");

-- CreateIndex
CREATE INDEX "reconciliation_exceptions_session_id_severity_idx" ON "reconciliation_exceptions"("session_id", "severity");

-- CreateIndex
CREATE INDEX "reconciliation_exceptions_import_row_id_idx" ON "reconciliation_exceptions"("import_row_id");

-- CreateIndex
CREATE INDEX "reconciliation_adjustments_session_id_idx" ON "reconciliation_adjustments"("session_id");

-- CreateIndex
CREATE INDEX "reconciliation_adjustments_session_id_status_idx" ON "reconciliation_adjustments"("session_id", "status");

-- CreateIndex
CREATE INDEX "reconciliation_adjustments_account_id_idx" ON "reconciliation_adjustments"("account_id");

-- CreateIndex
CREATE INDEX "reconciliation_adjustments_journal_entry_id_idx" ON "reconciliation_adjustments"("journal_entry_id");

-- AddForeignKey
ALTER TABLE "matching_rules" ADD CONSTRAINT "matching_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_sessions" ADD CONSTRAINT "reconciliation_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_sessions" ADD CONSTRAINT "reconciliation_sessions_treasury_account_id_fkey" FOREIGN KEY ("treasury_account_id") REFERENCES "treasury_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_sessions" ADD CONSTRAINT "reconciliation_sessions_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "import_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_sessions" ADD CONSTRAINT "reconciliation_sessions_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "financial_periods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_matches" ADD CONSTRAINT "reconciliation_matches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_matches" ADD CONSTRAINT "reconciliation_matches_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "reconciliation_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_matches" ADD CONSTRAINT "reconciliation_matches_import_row_id_fkey" FOREIGN KEY ("import_row_id") REFERENCES "import_rows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_matches" ADD CONSTRAINT "reconciliation_matches_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_matches" ADD CONSTRAINT "reconciliation_matches_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_exceptions" ADD CONSTRAINT "reconciliation_exceptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_exceptions" ADD CONSTRAINT "reconciliation_exceptions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "reconciliation_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_exceptions" ADD CONSTRAINT "reconciliation_exceptions_import_row_id_fkey" FOREIGN KEY ("import_row_id") REFERENCES "import_rows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_exceptions" ADD CONSTRAINT "reconciliation_exceptions_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_adjustments" ADD CONSTRAINT "reconciliation_adjustments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_adjustments" ADD CONSTRAINT "reconciliation_adjustments_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "reconciliation_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_adjustments" ADD CONSTRAINT "reconciliation_adjustments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_adjustments" ADD CONSTRAINT "reconciliation_adjustments_reason_code_id_fkey" FOREIGN KEY ("reason_code_id") REFERENCES "reason_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_adjustments" ADD CONSTRAINT "reconciliation_adjustments_approval_request_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "approval_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_adjustments" ADD CONSTRAINT "reconciliation_adjustments_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
