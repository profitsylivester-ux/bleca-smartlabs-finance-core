-- CreateEnum
CREATE TYPE "AnomalyType" AS ENUM ('DUPLICATE_TRANSACTION', 'DUPLICATE_INVOICE', 'UNUSUAL_SPENDING', 'UNUSUAL_LOGIN_ACTIVITY', 'SUSPICIOUS_PAYMENT_CHANGE', 'SOD_VIOLATION', 'ROUNDING_PATTERN', 'WEEKEND_TRANSACTION', 'AMOUNT_OUTLIER', 'LATE_NIGHT_ACTIVITY');

-- CreateEnum
CREATE TYPE "AnomalySeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AnomalyStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'DISMISSED', 'CONFIRMED', 'RESOLVED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'NOTIFICATION_READ';
ALTER TYPE "AuditAction" ADD VALUE 'NOTIFICATION_PREFERENCE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'ANOMALY_FLAG_RAISED';
ALTER TYPE "AuditAction" ADD VALUE 'ANOMALY_FLAG_ACKNOWLEDGED';
ALTER TYPE "AuditAction" ADD VALUE 'ANOMALY_FLAG_DISMISSED';
ALTER TYPE "AuditAction" ADD VALUE 'ANOMALY_FLAG_CONFIRMED';
ALTER TYPE "AuditAction" ADD VALUE 'ANOMALY_SCAN_COMPLETED';

-- AlterEnum
ALTER TYPE "AuditEntityType" ADD VALUE 'ANOMALY_FLAG';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationCategory" ADD VALUE 'BUDGET_ALERT';
ALTER TYPE "NotificationCategory" ADD VALUE 'PAYMENT_REMINDER';
ALTER TYPE "NotificationCategory" ADD VALUE 'COMPLIANCE_ALERT';
ALTER TYPE "NotificationCategory" ADD VALUE 'PERIOD_CLOSE';
ALTER TYPE "NotificationCategory" ADD VALUE 'RECONCILIATION';
ALTER TYPE "NotificationCategory" ADD VALUE 'STATEMENT_IMPORT';
ALTER TYPE "NotificationCategory" ADD VALUE 'OVER_BUDGET';
ALTER TYPE "NotificationCategory" ADD VALUE 'ANOMALY';
ALTER TYPE "NotificationCategory" ADD VALUE 'REPORT_READY';

-- CreateTable
CREATE TABLE "anomaly_flags" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "anomaly_type" "AnomalyType" NOT NULL,
    "severity" "AnomalySeverity" NOT NULL DEFAULT 'MEDIUM',
    "status" "AnomalyStatus" NOT NULL DEFAULT 'OPEN',
    "entity_type" "AuditEntityType" NOT NULL,
    "entity_id" TEXT NOT NULL,
    "entity_label" TEXT,
    "description" TEXT NOT NULL,
    "evidence" JSONB,
    "dedupe_key" TEXT,
    "acknowledged_at" TIMESTAMP(3),
    "acknowledged_by_id" TEXT,
    "dismissed_at" TIMESTAMP(3),
    "dismissed_by_id" TEXT,
    "dismiss_reason" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "confirmed_by_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "anomaly_flags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "anomaly_flags_organization_id_status_created_at_idx" ON "anomaly_flags"("organization_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "anomaly_flags_organization_id_anomaly_type_status_idx" ON "anomaly_flags"("organization_id", "anomaly_type", "status");

-- CreateIndex
CREATE INDEX "anomaly_flags_entity_type_entity_id_idx" ON "anomaly_flags"("entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "anomaly_flags_organization_id_dedupe_key_key" ON "anomaly_flags"("organization_id", "dedupe_key");

-- AddForeignKey
ALTER TABLE "anomaly_flags" ADD CONSTRAINT "anomaly_flags_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anomaly_flags" ADD CONSTRAINT "anomaly_flags_acknowledged_by_id_fkey" FOREIGN KEY ("acknowledged_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anomaly_flags" ADD CONSTRAINT "anomaly_flags_dismissed_by_id_fkey" FOREIGN KEY ("dismissed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anomaly_flags" ADD CONSTRAINT "anomaly_flags_confirmed_by_id_fkey" FOREIGN KEY ("confirmed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
