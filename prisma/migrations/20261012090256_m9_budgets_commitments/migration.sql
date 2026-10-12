/*
  Warnings:

  - Added the required column `currency_code` to the `budgets` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "CommitmentStatus" AS ENUM ('OPEN', 'PARTIALLY_SETTLED', 'SETTLED', 'CANCELLED', 'EXPIRED', 'OVERDUE');

-- CreateEnum
CREATE TYPE "CommitmentSource" AS ENUM ('INVOICE', 'PURCHASE_COMMITMENT', 'CONTRACT', 'PAYMENT_SCHEDULE', 'MANUAL');

-- CreateEnum
CREATE TYPE "ScenarioKind" AS ENUM ('BEST_CASE', 'EXPECTED_CASE', 'WORST_CASE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "BudgetRevisionStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BudgetTransferStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'BUDGET_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'BUDGET_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'BUDGET_SUBMITTED';
ALTER TYPE "AuditAction" ADD VALUE 'BUDGET_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE 'BUDGET_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE 'BUDGET_ACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'BUDGET_CLOSED';
ALTER TYPE "AuditAction" ADD VALUE 'BUDGET_LINE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'BUDGET_LINE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'BUDGET_AVAILABILITY_RECOMPUTED';
ALTER TYPE "AuditAction" ADD VALUE 'BUDGET_REVISION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'BUDGET_REVISION_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE 'BUDGET_REVISION_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE 'BUDGET_TRANSFER_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'BUDGET_TRANSFER_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE 'BUDGET_TRANSFER_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE 'COMMITMENT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'COMMITMENT_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'COMMITMENT_SETTLED';
ALTER TYPE "AuditAction" ADD VALUE 'COMMITMENT_CANCELLED';
ALTER TYPE "AuditAction" ADD VALUE 'BUDGET_SCENARIO_CREATED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEntityType" ADD VALUE 'BUDGET';
ALTER TYPE "AuditEntityType" ADD VALUE 'BUDGET_LINE';
ALTER TYPE "AuditEntityType" ADD VALUE 'BUDGET_REVISION';
ALTER TYPE "AuditEntityType" ADD VALUE 'BUDGET_TRANSFER';
ALTER TYPE "AuditEntityType" ADD VALUE 'COMMITMENT';
ALTER TYPE "AuditEntityType" ADD VALUE 'BUDGET_SCENARIO';

-- AlterTable
ALTER TABLE "budget_lines" ADD COLUMN     "actual_amount" DECIMAL(20,6) NOT NULL DEFAULT 0,
ADD COLUMN     "available_amount" DECIMAL(20,6) NOT NULL DEFAULT 0,
ADD COLUMN     "committed_amount" DECIMAL(20,6) NOT NULL DEFAULT 0,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "is_over_budget" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "phasing" JSONB;

-- AlterTable
ALTER TABLE "budgets" ADD COLUMN     "activated_at" TIMESTAMP(3),
ADD COLUMN     "activity" TEXT,
ADD COLUMN     "actual_amount" DECIMAL(20,6) NOT NULL DEFAULT 0,
ADD COLUMN     "approved_amount" DECIMAL(20,6) NOT NULL DEFAULT 0,
ADD COLUMN     "approved_at" TIMESTAMP(3),
ADD COLUMN     "approved_by_id" TEXT,
ADD COLUMN     "available_amount" DECIMAL(20,6) NOT NULL DEFAULT 0,
ADD COLUMN     "closed_at" TIMESTAMP(3),
ADD COLUMN     "committed_amount" DECIMAL(20,6) NOT NULL DEFAULT 0,
ADD COLUMN     "cost_centre_id" TEXT,
ADD COLUMN     "created_by_id" TEXT,
ADD COLUMN     "currency_code" CHAR(3) NOT NULL,
ADD COLUMN     "department_id" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "funding_source_id" TEXT,
ADD COLUMN     "is_over_budget" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "project_id" TEXT;

-- CreateTable
CREATE TABLE "commitments" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "budget_id" TEXT,
    "budget_line_id" TEXT,
    "account_id" TEXT NOT NULL,
    "source" "CommitmentSource" NOT NULL,
    "source_id" TEXT,
    "description" TEXT,
    "amount" DECIMAL(20,6) NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "status" "CommitmentStatus" NOT NULL DEFAULT 'OPEN',
    "commitment_date" TIMESTAMP(3) NOT NULL,
    "expected_date" TIMESTAMP(3),
    "project_id" TEXT,
    "department_id" TEXT,
    "funding_source_id" TEXT,
    "settled_at" TIMESTAMP(3),
    "released_at" TIMESTAMP(3),
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commitments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_revisions" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "budget_id" TEXT NOT NULL,
    "revision_number" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "BudgetRevisionStatus" NOT NULL DEFAULT 'DRAFT',
    "created_by_id" TEXT,
    "submitted_at" TIMESTAMP(3),
    "approved_by_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "rejected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budget_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_revision_lines" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "revision_id" TEXT NOT NULL,
    "budget_line_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "before_amount" DECIMAL(20,6) NOT NULL,
    "after_amount" DECIMAL(20,6) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_revision_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_transfers" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "budget_id" TEXT NOT NULL,
    "transfer_number" INTEGER NOT NULL,
    "from_line_id" TEXT NOT NULL,
    "to_line_id" TEXT NOT NULL,
    "amount" DECIMAL(20,6) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "BudgetTransferStatus" NOT NULL DEFAULT 'DRAFT',
    "created_by_id" TEXT,
    "approved_by_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "applied_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budget_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_scenarios" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "budget_id" TEXT NOT NULL,
    "kind" "ScenarioKind" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "adjustment_factor" DECIMAL(20,6) NOT NULL,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "commitments_budget_id_status_idx" ON "commitments"("budget_id", "status");

-- CreateIndex
CREATE INDEX "commitments_budget_line_id_status_idx" ON "commitments"("budget_line_id", "status");

-- CreateIndex
CREATE INDEX "commitments_status_expected_date_idx" ON "commitments"("status", "expected_date");

-- CreateIndex
CREATE INDEX "commitments_commitment_date_idx" ON "commitments"("commitment_date");

-- CreateIndex
CREATE INDEX "commitments_account_id_idx" ON "commitments"("account_id");

-- CreateIndex
CREATE INDEX "commitments_source_source_id_idx" ON "commitments"("source", "source_id");

-- CreateIndex
CREATE INDEX "budget_revisions_budget_id_status_idx" ON "budget_revisions"("budget_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "budget_revisions_budget_id_revision_number_key" ON "budget_revisions"("budget_id", "revision_number");

-- CreateIndex
CREATE INDEX "budget_revision_lines_budget_line_id_idx" ON "budget_revision_lines"("budget_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "budget_revision_lines_revision_id_budget_line_id_key" ON "budget_revision_lines"("revision_id", "budget_line_id");

-- CreateIndex
CREATE INDEX "budget_transfers_budget_id_status_idx" ON "budget_transfers"("budget_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "budget_transfers_budget_id_transfer_number_key" ON "budget_transfers"("budget_id", "transfer_number");

-- CreateIndex
CREATE INDEX "budget_scenarios_budget_id_idx" ON "budget_scenarios"("budget_id");

-- CreateIndex
CREATE INDEX "budgets_status_idx" ON "budgets"("status");

-- CreateIndex
CREATE INDEX "budgets_type_status_idx" ON "budgets"("type", "status");

-- CreateIndex
CREATE INDEX "budgets_project_id_idx" ON "budgets"("project_id");

-- CreateIndex
CREATE INDEX "budgets_department_id_idx" ON "budgets"("department_id");

-- CreateIndex
CREATE INDEX "budgets_funding_source_id_idx" ON "budgets"("funding_source_id");

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_funding_source_id_fkey" FOREIGN KEY ("funding_source_id") REFERENCES "funding_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_cost_centre_id_fkey" FOREIGN KEY ("cost_centre_id") REFERENCES "cost_centres"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "budgets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_budget_line_id_fkey" FOREIGN KEY ("budget_line_id") REFERENCES "budget_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_funding_source_id_fkey" FOREIGN KEY ("funding_source_id") REFERENCES "funding_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_revisions" ADD CONSTRAINT "budget_revisions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_revisions" ADD CONSTRAINT "budget_revisions_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_revisions" ADD CONSTRAINT "budget_revisions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_revisions" ADD CONSTRAINT "budget_revisions_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_revision_lines" ADD CONSTRAINT "budget_revision_lines_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "budget_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_revision_lines" ADD CONSTRAINT "budget_revision_lines_budget_line_id_fkey" FOREIGN KEY ("budget_line_id") REFERENCES "budget_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_transfers" ADD CONSTRAINT "budget_transfers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_transfers" ADD CONSTRAINT "budget_transfers_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_transfers" ADD CONSTRAINT "budget_transfers_from_line_id_fkey" FOREIGN KEY ("from_line_id") REFERENCES "budget_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_transfers" ADD CONSTRAINT "budget_transfers_to_line_id_fkey" FOREIGN KEY ("to_line_id") REFERENCES "budget_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_transfers" ADD CONSTRAINT "budget_transfers_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_transfers" ADD CONSTRAINT "budget_transfers_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_scenarios" ADD CONSTRAINT "budget_scenarios_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_scenarios" ADD CONSTRAINT "budget_scenarios_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_scenarios" ADD CONSTRAINT "budget_scenarios_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
