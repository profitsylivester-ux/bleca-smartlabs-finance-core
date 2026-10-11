/*
  Warnings:

  - The primary key for the `reversal_reason_codes` table will be changed. If it partially fails, the table could be left without primary key constraint.

*/
-- CreateEnum
CREATE TYPE "ApprovalEntityType" AS ENUM ('TRANSACTION', 'JOURNAL_ENTRY', 'INVOICE', 'PAYMENT', 'RECEIPT', 'QUOTATION', 'CREDIT_NOTE', 'DEBIT_NOTE', 'REFUND', 'BUDGET', 'BUDGET_REVISION', 'BUDGET_TRANSFER', 'COMMITMENT', 'PERIOD_REOPEN', 'FINANCIAL_CLOSE', 'ADJUSTMENT', 'REVERSAL', 'MASTER_DATA_CHANGE', 'SUPPLIER_BANK_DETAIL_CHANGE', 'CUSTOMER_CREDIT_LIMIT', 'DOCUMENT', 'IMPORT_BATCH', 'RECONCILIATION', 'RECONCILIATION_ADJUSTMENT', 'TAX_FILING');

-- CreateEnum
CREATE TYPE "ApprovalRequestStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ApprovalStepType" AS ENUM ('APPROVAL', 'REVIEW', 'NOTIFICATION', 'SIGN_OFF');

-- CreateEnum
CREATE TYPE "ApprovalAssigneeType" AS ENUM ('ROLE', 'USER', 'USER_DELEGATED', 'SPECIFIC_USER');

-- CreateEnum
CREATE TYPE "ApprovalOutcome" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ResolutionMode" AS ENUM ('ANY', 'ALL', 'QUORUM');

-- CreateEnum
CREATE TYPE "ApprovalConditionOperator" AS ENUM ('ALWAYS', 'AMOUNT_GREATER_THAN', 'AMOUNT_GREATER_OR_EQUAL', 'AMOUNT_LESS_THAN', 'AMOUNT_BETWEEN', 'PERCENT_OF_BUDGET', 'OVER_BUDGET', 'NEW_COUNTERPARTY', 'SUPPLIER_BANK_DETAIL_CHANGED', 'FUNDING_RESTRICTED', 'CROSS_PROJECT', 'CURRENCY_NOT_BASE', 'MANUAL_FLAG');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVED', 'REJECTED', 'DEFERRED', 'RETURNED_FOR_CHANGES', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SODWaiverStatus" AS ENUM ('PENDING', 'GRANTED', 'REJECTED', 'EXPIRED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'APPROVAL_POLICY_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'APPROVAL_POLICY_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'APPROVAL_POLICY_DELETED';
ALTER TYPE "AuditAction" ADD VALUE 'APPROVAL_REQUEST_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'APPROVAL_REQUEST_SUBMITTED';
ALTER TYPE "AuditAction" ADD VALUE 'APPROVAL_REQUEST_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE 'APPROVAL_REQUEST_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE 'APPROVAL_REQUEST_CANCELLED';
ALTER TYPE "AuditAction" ADD VALUE 'APPROVAL_STEP_DECIDED';
ALTER TYPE "AuditAction" ADD VALUE 'APPROVAL_DECISION_RECORDED';
ALTER TYPE "AuditAction" ADD VALUE 'SOD_WAIVER_GRANTED';
ALTER TYPE "AuditAction" ADD VALUE 'SOD_WAIVER_REJECTED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEntityType" ADD VALUE 'ACCOUNT';
ALTER TYPE "AuditEntityType" ADD VALUE 'FINANCIAL_PERIOD';
ALTER TYPE "AuditEntityType" ADD VALUE 'OPENING_BALANCE';
ALTER TYPE "AuditEntityType" ADD VALUE 'ACCOUNT_BALANCE_SNAPSHOT';
ALTER TYPE "AuditEntityType" ADD VALUE 'APPROVAL_POLICY';
ALTER TYPE "AuditEntityType" ADD VALUE 'APPROVAL_REQUEST';
ALTER TYPE "AuditEntityType" ADD VALUE 'APPROVAL_STEP_INSTANCE';
ALTER TYPE "AuditEntityType" ADD VALUE 'APPROVAL_DECISION_RECORD';
ALTER TYPE "AuditEntityType" ADD VALUE 'SOD_WAIVER';

-- DropForeignKey
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_adjusting_entry_id_fkey";

-- DropForeignKey
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_approved_by_id_fkey";

-- DropForeignKey
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_posted_by_id_fkey";

-- DropForeignKey
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_reversal_reason_id_fkey";

-- DropForeignKey
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_reversed_by_id_fkey";

-- DropForeignKey
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_reversed_entry_id_fkey";

-- DropForeignKey
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_submitted_by_id_fkey";

-- DropForeignKey
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_voided_by_id_fkey";

-- DropForeignKey
ALTER TABLE "journal_lines" DROP CONSTRAINT "journal_lines_cost_centre_id_fkey";

-- DropForeignKey
ALTER TABLE "journal_lines" DROP CONSTRAINT "journal_lines_department_id_fkey";

-- DropForeignKey
ALTER TABLE "journal_lines" DROP CONSTRAINT "journal_lines_funding_source_id_fkey";

-- DropForeignKey
ALTER TABLE "journal_lines" DROP CONSTRAINT "journal_lines_location_id_fkey";

-- DropForeignKey
ALTER TABLE "journal_lines" DROP CONSTRAINT "journal_lines_project_id_fkey";

-- DropForeignKey
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_account_id_fkey";

-- DropForeignKey
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_adjusting_entry_id_fkey";

-- DropForeignKey
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_approved_by_id_fkey";

-- DropForeignKey
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_cost_centre_id_fkey";

-- DropForeignKey
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_department_id_fkey";

-- DropForeignKey
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_funding_source_id_fkey";

-- DropForeignKey
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_location_id_fkey";

-- DropForeignKey
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_posted_by_id_fkey";

-- DropForeignKey
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_project_id_fkey";

-- DropForeignKey
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_reversal_reason_id_fkey";

-- DropForeignKey
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_reversed_by_id_fkey";

-- DropForeignKey
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_submitted_by_id_fkey";

-- DropForeignKey
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_voided_by_id_fkey";

-- DropIndex
DROP INDEX "reversal_reason_codes_organization_id_idx";

-- AlterTable
ALTER TABLE "journal_entries" ALTER COLUMN "number" SET DATA TYPE TEXT,
ALTER COLUMN "adjusting_entry_id" SET DATA TYPE TEXT,
ALTER COLUMN "reversal_reason_id" SET DATA TYPE TEXT,
ALTER COLUMN "reversed_entry_id" SET DATA TYPE TEXT,
ALTER COLUMN "submitted_by_id" SET DATA TYPE TEXT,
ALTER COLUMN "submitted_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "approved_by_id" SET DATA TYPE TEXT,
ALTER COLUMN "approved_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "reversed_by_id" SET DATA TYPE TEXT,
ALTER COLUMN "reversed_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "voided_by_id" SET DATA TYPE TEXT,
ALTER COLUMN "voided_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "journal_lines" ALTER COLUMN "line_number" DROP DEFAULT,
ALTER COLUMN "base_amount" DROP DEFAULT,
ALTER COLUMN "project_id" SET DATA TYPE TEXT,
ALTER COLUMN "department_id" SET DATA TYPE TEXT,
ALTER COLUMN "cost_centre_id" SET DATA TYPE TEXT,
ALTER COLUMN "location_id" SET DATA TYPE TEXT,
ALTER COLUMN "funding_source_id" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "reversal_reason_codes" DROP CONSTRAINT "reversal_reason_codes_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "organization_id" SET DATA TYPE TEXT,
ALTER COLUMN "code" SET DATA TYPE TEXT,
ALTER COLUMN "name" SET DATA TYPE TEXT,
ALTER COLUMN "category" SET DATA TYPE TEXT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" DROP DEFAULT,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "reversal_reason_codes_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "transactions" ALTER COLUMN "number" SET DATA TYPE TEXT,
ALTER COLUMN "account_id" SET DATA TYPE TEXT,
ALTER COLUMN "amount" DROP DEFAULT,
ALTER COLUMN "currency_code" DROP DEFAULT,
ALTER COLUMN "project_id" SET DATA TYPE TEXT,
ALTER COLUMN "department_id" SET DATA TYPE TEXT,
ALTER COLUMN "cost_centre_id" SET DATA TYPE TEXT,
ALTER COLUMN "location_id" SET DATA TYPE TEXT,
ALTER COLUMN "funding_source_id" SET DATA TYPE TEXT,
ALTER COLUMN "supporting_document_id" SET DATA TYPE TEXT,
ALTER COLUMN "created_by_id" SET DATA TYPE TEXT,
ALTER COLUMN "submitted_by_id" SET DATA TYPE TEXT,
ALTER COLUMN "submitted_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "approved_by_id" SET DATA TYPE TEXT,
ALTER COLUMN "approved_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "posted_by_id" SET DATA TYPE TEXT,
ALTER COLUMN "posted_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "reversed_by_id" SET DATA TYPE TEXT,
ALTER COLUMN "reversed_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "voided_by_id" SET DATA TYPE TEXT,
ALTER COLUMN "voided_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "reversal_reason_id" SET DATA TYPE TEXT,
ALTER COLUMN "adjusting_entry_id" SET DATA TYPE TEXT;

-- CreateTable
CREATE TABLE "approval_policies" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "entityType" "ApprovalEntityType" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_policy_steps" (
    "id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "step_order" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ApprovalStepType" NOT NULL,
    "assignee_type" "ApprovalAssigneeType" NOT NULL,
    "assignee_role_id" TEXT,
    "assignee_user_id" TEXT,
    "resolution_mode" "ResolutionMode" NOT NULL DEFAULT 'ANY',
    "quorum" INTEGER,
    "condition_operator" "ApprovalConditionOperator",
    "condition_value" JSONB,
    "is_required" BOOLEAN NOT NULL DEFAULT true,
    "is_final_approver" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_policy_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "entity_type" "ApprovalEntityType" NOT NULL,
    "entity_id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "status" "ApprovalRequestStatus" NOT NULL DEFAULT 'PENDING',
    "submitted_by_id" TEXT NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "current_step_index" INTEGER NOT NULL DEFAULT 0,
    "decided_at" TIMESTAMP(3),
    "decided_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_step_instances" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "step_order" INTEGER NOT NULL,
    "step_name" TEXT NOT NULL,
    "step_type" "ApprovalStepType" NOT NULL,
    "assignee_type" "ApprovalAssigneeType" NOT NULL,
    "assignee_role_id" TEXT,
    "assignee_user_id" TEXT,
    "resolution_mode" "ResolutionMode" NOT NULL,
    "quorum" INTEGER,
    "status" "ApprovalRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decided_at" TIMESTAMP(3),
    "decided_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_step_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_decision_records" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "step_instance_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "decision" "ApprovalDecision" NOT NULL,
    "reason" TEXT,
    "sod_violation" BOOLEAN NOT NULL DEFAULT false,
    "sod_waiver_id" TEXT,
    "delegation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_decision_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sod_waivers" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "recorded_by_id" TEXT NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approval_request_id" TEXT NOT NULL,
    "status" "SODWaiverStatus" NOT NULL DEFAULT 'PENDING',
    "reviewed_by_id" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "review_reason" TEXT,

    CONSTRAINT "sod_waivers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "approval_policies_organization_id_entityType_isActive_idx" ON "approval_policies"("organization_id", "entityType", "isActive");

-- CreateIndex
CREATE INDEX "approval_policy_steps_policy_id_idx" ON "approval_policy_steps"("policy_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_policy_steps_policy_id_step_order_key" ON "approval_policy_steps"("policy_id", "step_order");

-- CreateIndex
CREATE INDEX "approval_requests_organization_id_entity_type_entity_id_idx" ON "approval_requests"("organization_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "approval_requests_status_idx" ON "approval_requests"("status");

-- CreateIndex
CREATE INDEX "approval_requests_submitted_by_id_idx" ON "approval_requests"("submitted_by_id");

-- CreateIndex
CREATE INDEX "approval_step_instances_request_id_idx" ON "approval_step_instances"("request_id");

-- CreateIndex
CREATE INDEX "approval_step_instances_assignee_user_id_status_idx" ON "approval_step_instances"("assignee_user_id", "status");

-- CreateIndex
CREATE INDEX "approval_step_instances_assignee_role_id_status_idx" ON "approval_step_instances"("assignee_role_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "approval_step_instances_request_id_step_order_key" ON "approval_step_instances"("request_id", "step_order");

-- CreateIndex
CREATE INDEX "approval_decision_records_request_id_idx" ON "approval_decision_records"("request_id");

-- CreateIndex
CREATE INDEX "approval_decision_records_step_instance_id_idx" ON "approval_decision_records"("step_instance_id");

-- CreateIndex
CREATE INDEX "approval_decision_records_actor_id_idx" ON "approval_decision_records"("actor_id");

-- CreateIndex
CREATE INDEX "sod_waivers_user_id_idx" ON "sod_waivers"("user_id");

-- CreateIndex
CREATE INDEX "sod_waivers_transaction_id_idx" ON "sod_waivers"("transaction_id");

-- CreateIndex
CREATE INDEX "sod_waivers_approval_request_id_idx" ON "sod_waivers"("approval_request_id");

-- CreateIndex
CREATE INDEX "sod_waivers_status_idx" ON "sod_waivers"("status");

-- AddForeignKey
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_policy_steps" ADD CONSTRAINT "approval_policy_steps_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "approval_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_policy_steps" ADD CONSTRAINT "approval_policy_steps_assignee_role_id_fkey" FOREIGN KEY ("assignee_role_id") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_policy_steps" ADD CONSTRAINT "approval_policy_steps_assignee_user_id_fkey" FOREIGN KEY ("assignee_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "approval_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_step_instances" ADD CONSTRAINT "approval_step_instances_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "approval_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_step_instances" ADD CONSTRAINT "approval_step_instances_assignee_role_id_fkey" FOREIGN KEY ("assignee_role_id") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_step_instances" ADD CONSTRAINT "approval_step_instances_assignee_user_id_fkey" FOREIGN KEY ("assignee_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_step_instances" ADD CONSTRAINT "approval_step_instances_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_decision_records" ADD CONSTRAINT "approval_decision_records_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "approval_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_decision_records" ADD CONSTRAINT "approval_decision_records_step_instance_id_fkey" FOREIGN KEY ("step_instance_id") REFERENCES "approval_step_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_decision_records" ADD CONSTRAINT "approval_decision_records_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sod_waivers" ADD CONSTRAINT "sod_waivers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sod_waivers" ADD CONSTRAINT "sod_waivers_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sod_waivers" ADD CONSTRAINT "sod_waivers_approval_request_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "approval_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sod_waivers" ADD CONSTRAINT "sod_waivers_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_adjusting_entry_id_fkey" FOREIGN KEY ("adjusting_entry_id") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversal_reason_id_fkey" FOREIGN KEY ("reversal_reason_id") REFERENCES "reversal_reason_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversed_entry_id_fkey" FOREIGN KEY ("reversed_entry_id") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_posted_by_id_fkey" FOREIGN KEY ("posted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversed_by_id_fkey" FOREIGN KEY ("reversed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_cost_centre_id_fkey" FOREIGN KEY ("cost_centre_id") REFERENCES "cost_centres"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_funding_source_id_fkey" FOREIGN KEY ("funding_source_id") REFERENCES "funding_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reversal_reason_codes" ADD CONSTRAINT "reversal_reason_codes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_cost_centre_id_fkey" FOREIGN KEY ("cost_centre_id") REFERENCES "cost_centres"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_funding_source_id_fkey" FOREIGN KEY ("funding_source_id") REFERENCES "funding_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_posted_by_id_fkey" FOREIGN KEY ("posted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_reversed_by_id_fkey" FOREIGN KEY ("reversed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_reversal_reason_id_fkey" FOREIGN KEY ("reversal_reason_id") REFERENCES "reversal_reason_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_adjusting_entry_id_fkey" FOREIGN KEY ("adjusting_entry_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
