-- CreateEnum
CREATE TYPE "TreasuryAccountKind" AS ENUM ('CASH', 'BANK', 'MOBILE_MONEY', 'PAYMENT_GATEWAY', 'PROJECT_FUND', 'GRANT_FUND', 'OTHER');

-- AlterTable
ALTER TABLE "journal_lines" ADD COLUMN     "treasury_account_id" TEXT;

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "treasury_account_id" TEXT;

-- CreateTable
CREATE TABLE "treasury_accounts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "TreasuryAccountKind" NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "ledger_account_id" TEXT NOT NULL,
    "location_id" TEXT,
    "funding_source_id" TEXT,
    "account_number_enc" TEXT,
    "provider_config_enc" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_restricted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "treasury_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_schedules" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "treasury_account_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "amount" DECIMAL(20,6) NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "frequency" TEXT NOT NULL,
    "next_due_date" DATE NOT NULL,
    "end_date" DATE,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "treasury_accounts_kind_is_active_idx" ON "treasury_accounts"("kind", "is_active");

-- CreateIndex
CREATE INDEX "treasury_accounts_ledger_account_id_idx" ON "treasury_accounts"("ledger_account_id");

-- CreateIndex
CREATE INDEX "treasury_accounts_funding_source_id_idx" ON "treasury_accounts"("funding_source_id");

-- CreateIndex
CREATE UNIQUE INDEX "treasury_accounts_organization_id_code_key" ON "treasury_accounts"("organization_id", "code");

-- CreateIndex
CREATE INDEX "payment_schedules_treasury_account_id_status_idx" ON "payment_schedules"("treasury_account_id", "status");

-- CreateIndex
CREATE INDEX "payment_schedules_next_due_date_idx" ON "payment_schedules"("next_due_date");

-- CreateIndex
CREATE UNIQUE INDEX "payment_schedules_organization_id_code_key" ON "payment_schedules"("organization_id", "code");

-- CreateIndex
CREATE INDEX "journal_lines_treasury_account_id_idx" ON "journal_lines"("treasury_account_id");

-- CreateIndex
CREATE INDEX "transactions_treasury_account_id_idx" ON "transactions"("treasury_account_id");

-- AddForeignKey
ALTER TABLE "treasury_accounts" ADD CONSTRAINT "treasury_accounts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treasury_accounts" ADD CONSTRAINT "treasury_accounts_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treasury_accounts" ADD CONSTRAINT "treasury_accounts_ledger_account_id_fkey" FOREIGN KEY ("ledger_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treasury_accounts" ADD CONSTRAINT "treasury_accounts_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treasury_accounts" ADD CONSTRAINT "treasury_accounts_funding_source_id_fkey" FOREIGN KEY ("funding_source_id") REFERENCES "funding_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_schedules" ADD CONSTRAINT "payment_schedules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_schedules" ADD CONSTRAINT "payment_schedules_treasury_account_id_fkey" FOREIGN KEY ("treasury_account_id") REFERENCES "treasury_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_schedules" ADD CONSTRAINT "payment_schedules_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_treasury_account_id_fkey" FOREIGN KEY ("treasury_account_id") REFERENCES "treasury_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_treasury_account_id_fkey" FOREIGN KEY ("treasury_account_id") REFERENCES "treasury_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
