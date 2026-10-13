-- CreateEnum
CREATE TYPE "BackupType" AS ENUM ('FULL', 'INCREMENTAL', 'POINT_IN_TIME');

-- CreateEnum
CREATE TYPE "BackupStatus" AS ENUM ('SCHEDULED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'VERIFIED', 'VERIFICATION_FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SyncActionType" AS ENUM ('RECEIPT_CAPTURE', 'DRAFT_SAVE', 'CONTACT_CARD_SAVE', 'SUBMIT', 'APPROVE', 'REJECT', 'POST', 'REVERSE', 'PERIOD_CLOSE', 'PERIOD_REOPEN');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('QUEUED', 'SYNCING', 'SYNCED', 'CONFLICT', 'FAILED', 'DISCARDED');

-- CreateTable
CREATE TABLE "backup_runs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "type" "BackupType" NOT NULL,
    "status" "BackupStatus" NOT NULL DEFAULT 'SCHEDULED',
    "storage_key" TEXT NOT NULL,
    "checksum" CHAR(64) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "row_counts" JSONB,
    "audit_chain_head" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "verified_at" TIMESTAMP(3),
    "verification_checksum" TEXT,
    "restore_tested_at" TIMESTAMP(3),
    "restore_test_result" JSONB,
    "error_message" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "backup_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_queue_items" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "actionType" "SyncActionType" NOT NULL,
    "payload" JSONB NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'QUEUED',
    "conflict_detail" JSONB,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMP(3),
    "synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_queue_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "backup_runs_organization_id_status_idx" ON "backup_runs"("organization_id", "status");

-- CreateIndex
CREATE INDEX "backup_runs_organization_id_created_at_idx" ON "backup_runs"("organization_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "sync_queue_items_idempotency_key_key" ON "sync_queue_items"("idempotency_key");

-- CreateIndex
CREATE INDEX "sync_queue_items_organization_id_status_idx" ON "sync_queue_items"("organization_id", "status");

-- CreateIndex
CREATE INDEX "sync_queue_items_user_id_status_idx" ON "sync_queue_items"("user_id", "status");

-- CreateIndex
CREATE INDEX "sync_queue_items_idempotency_key_idx" ON "sync_queue_items"("idempotency_key");

-- AddForeignKey
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_queue_items" ADD CONSTRAINT "sync_queue_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
