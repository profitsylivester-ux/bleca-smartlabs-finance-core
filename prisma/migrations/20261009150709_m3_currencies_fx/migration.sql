-- CreateEnum
CREATE TYPE "CurrencyType" AS ENUM ('FIAT', 'CRYPTO', 'COMPOSITE');

-- CreateEnum
CREATE TYPE "FxDifferenceTreatment" AS ENUM ('EXPENSE', 'INCOME', 'SUSPENSE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEntityType" ADD VALUE 'PROJECT';
ALTER TYPE "AuditEntityType" ADD VALUE 'FUNDING_SOURCE';
ALTER TYPE "AuditEntityType" ADD VALUE 'CURRENCY';
ALTER TYPE "AuditEntityType" ADD VALUE 'EXCHANGE_RATE';

-- CreateTable
CREATE TABLE "currencies" (
    "id" TEXT NOT NULL,
    "code" CHAR(3) NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT,
    "type" "CurrencyType" NOT NULL DEFAULT 'FIAT',
    "decimalPlaces" INTEGER NOT NULL DEFAULT 2,
    "is_base" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "currencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" TEXT NOT NULL,
    "base_currency_id" TEXT NOT NULL,
    "quote_currency_id" TEXT NOT NULL,
    "rate_date" TIMESTAMP(3) NOT NULL,
    "rate" DECIMAL(20,10) NOT NULL,
    "source" TEXT DEFAULT 'MANUAL',
    "difference_treatment" "FxDifferenceTreatment" NOT NULL DEFAULT 'EXPENSE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "currencies_code_key" ON "currencies"("code");

-- CreateIndex
CREATE INDEX "exchange_rates_rate_date_idx" ON "exchange_rates"("rate_date");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_rates_base_currency_id_quote_currency_id_rate_date_key" ON "exchange_rates"("base_currency_id", "quote_currency_id", "rate_date");

-- AddForeignKey
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_base_currency_id_fkey" FOREIGN KEY ("base_currency_id") REFERENCES "currencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_quote_currency_id_fkey" FOREIGN KEY ("quote_currency_id") REFERENCES "currencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
