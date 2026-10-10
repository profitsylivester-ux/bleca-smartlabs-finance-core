-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');

-- CreateEnum
CREATE TYPE "NormalBalance" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "AccountSubCategory" AS ENUM ('CASH', 'BANK', 'MOBILE_MONEY', 'RECEIVABLE', 'INVENTORY', 'EQUIPMENT', 'OTHER_ASSET', 'SUPPLIER_PAYABLE', 'TAX_PAYABLE', 'LOAN', 'ACCRUED_EXPENSE', 'OTHER_OBLIGATION', 'CAPITAL', 'RETAINED_EARNINGS', 'FUTURE_INVESTMENT', 'REVENUE_TRAINING', 'REVENUE_CONSULTING', 'REVENUE_SOFTWARE', 'REVENUE_SAAS', 'REVENUE_AI_SERVICES', 'REVENUE_IOT_SERVICES', 'REVENUE_HARDWARE', 'REVENUE_ELECTRONICS', 'REVENUE_COMPONENT_SALES', 'REVENUE_SUBSCRIPTION', 'REVENUE_TOKEN_PACKAGES', 'REVENUE_OTHER', 'EXPENSE_INTERNET', 'EXPENSE_CLOUD', 'EXPENSE_AI_API', 'EXPENSE_TRANSPORT', 'EXPENSE_MARKETING', 'EXPENSE_SOFTWARE', 'EXPENSE_WORKSPACE', 'EXPENSE_SALARIES', 'EXPENSE_TRAINING', 'EXPENSE_HARDWARE_PROTOTYPING', 'EXPENSE_OTHER', 'CONTROL');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'LOCKED', 'PENDING_ARCHIVE');

-- CreateEnum
CREATE TYPE "PeriodType" AS ENUM ('MONTHLY', 'QUARTERLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "PeriodStatus" AS ENUM ('OPEN', 'CLOSING', 'CLOSED', 'LOCKED', 'REOPEN_PENDING', 'REOPENED');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('UNVERIFIED', 'PENDING_VERIFICATION', 'VERIFIED', 'DISPUTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "BudgetLevel" AS ENUM ('COMPANY', 'DEPARTMENT', 'PROJECT', 'FUNDING', 'ACTIVITY');

-- CreateEnum
CREATE TYPE "BudgetStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'ACTIVE', 'REVISED', 'CLOSED', 'EXPIRED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BudgetPeriodType" AS ENUM ('MONTHLY', 'QUARTERLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "JournalEntryType" AS ENUM ('STANDARD', 'OPENING_BALANCE', 'ADJUSTMENT', 'REVERSAL', 'CORRECTION', 'CLOSING', 'SYSTEM');

-- CreateEnum
CREATE TYPE "JournalEntryStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'POSTED', 'LOCKED', 'REVERSED', 'VOIDED');

-- CreateEnum
CREATE TYPE "JournalSource" AS ENUM ('MANUAL', 'TRANSACTION', 'INVOICE', 'PAYMENT', 'RECEIPT', 'TRANSFER', 'OPENING_BALANCE', 'CLOSE', 'REVERSAL', 'IMPORT');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'POSTED', 'LOCKED', 'ADJUSTED', 'REVERSED', 'CANCELLED');

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "AccountType" NOT NULL,
    "subCategory" "AccountSubCategory",
    "normalBalance" "NormalBalance" NOT NULL,
    "parent_id" TEXT,
    "is_postable" BOOLEAN NOT NULL DEFAULT true,
    "is_reconcilable" BOOLEAN NOT NULL DEFAULT false,
    "requires_document" BOOLEAN NOT NULL DEFAULT false,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "validated_by_qualified_accountant" BOOLEAN NOT NULL DEFAULT false,
    "validator_notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_periods" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "type" "PeriodType" NOT NULL,
    "status" "PeriodStatus" NOT NULL DEFAULT 'OPEN',
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3) NOT NULL,
    "is_adjustment" BOOLEAN NOT NULL DEFAULT false,
    "reopen_count" INTEGER NOT NULL DEFAULT 0,
    "closed_at" TIMESTAMP(3),
    "locked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "financial_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opening_balances" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "period_id" TEXT NOT NULL,
    "amount" DECIMAL(20,6) NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "is_unverified" BOOLEAN NOT NULL DEFAULT true,
    "verification_status" "VerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "verified_by_accountant_at" TIMESTAMP(3),
    "verified_by_accountant_id" TEXT,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "opening_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_balance_snapshots" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "period_id" TEXT NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "debit_total" DECIMAL(20,6) NOT NULL,
    "credit_total" DECIMAL(20,6) NOT NULL,
    "balance" DECIMAL(20,6) NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_balance_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "period_id" TEXT NOT NULL,
    "type" "JournalEntryType" NOT NULL DEFAULT 'STANDARD',
    "status" "JournalEntryStatus" NOT NULL DEFAULT 'DRAFT',
    "source" "JournalSource" NOT NULL DEFAULT 'MANUAL',
    "reference" TEXT,
    "description" TEXT,
    "transaction_id" TEXT,
    "posted_at" TIMESTAMP(3),
    "posted_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_lines" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "entry_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "debit" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "credit" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "currency_code" CHAR(3) NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'DRAFT',
    "date" DATE NOT NULL,
    "description" TEXT,
    "reference" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budgets" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "BudgetLevel" NOT NULL,
    "status" "BudgetStatus" NOT NULL DEFAULT 'DRAFT',
    "periodType" "BudgetPeriodType" NOT NULL,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_lines" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "budget_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "amount" DECIMAL(20,6) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budget_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "accounts_parent_id_idx" ON "accounts"("parent_id");

-- CreateIndex
CREATE INDEX "accounts_type_status_idx" ON "accounts"("type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_organization_id_code_key" ON "accounts"("organization_id", "code");

-- CreateIndex
CREATE INDEX "financial_periods_status_start_date_idx" ON "financial_periods"("status", "start_date");

-- CreateIndex
CREATE INDEX "financial_periods_type_start_date_idx" ON "financial_periods"("type", "start_date");

-- CreateIndex
CREATE UNIQUE INDEX "financial_periods_organization_id_code_key" ON "financial_periods"("organization_id", "code");

-- CreateIndex
CREATE INDEX "opening_balances_verification_status_idx" ON "opening_balances"("verification_status");

-- CreateIndex
CREATE UNIQUE INDEX "opening_balances_account_id_period_id_key" ON "opening_balances"("account_id", "period_id");

-- CreateIndex
CREATE INDEX "account_balance_snapshots_period_id_idx" ON "account_balance_snapshots"("period_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_balance_snapshots_account_id_period_id_currency_cod_key" ON "account_balance_snapshots"("account_id", "period_id", "currency_code");

-- CreateIndex
CREATE INDEX "journal_entries_period_id_status_idx" ON "journal_entries"("period_id", "status");

-- CreateIndex
CREATE INDEX "journal_entries_transaction_id_idx" ON "journal_entries"("transaction_id");

-- CreateIndex
CREATE INDEX "journal_lines_entry_id_idx" ON "journal_lines"("entry_id");

-- CreateIndex
CREATE INDEX "journal_lines_account_id_idx" ON "journal_lines"("account_id");

-- CreateIndex
CREATE INDEX "transactions_status_date_idx" ON "transactions"("status", "date");

-- CreateIndex
CREATE UNIQUE INDEX "budgets_organization_id_code_key" ON "budgets"("organization_id", "code");

-- CreateIndex
CREATE INDEX "budget_lines_account_id_idx" ON "budget_lines"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "budget_lines_budget_id_account_id_key" ON "budget_lines"("budget_id", "account_id");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_periods" ADD CONSTRAINT "financial_periods_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_balances" ADD CONSTRAINT "opening_balances_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_balances" ADD CONSTRAINT "opening_balances_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_balances" ADD CONSTRAINT "opening_balances_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "financial_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_balances" ADD CONSTRAINT "opening_balances_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_balance_snapshots" ADD CONSTRAINT "account_balance_snapshots_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_balance_snapshots" ADD CONSTRAINT "account_balance_snapshots_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_balance_snapshots" ADD CONSTRAINT "account_balance_snapshots_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "financial_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_balance_snapshots" ADD CONSTRAINT "account_balance_snapshots_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "financial_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "journal_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
