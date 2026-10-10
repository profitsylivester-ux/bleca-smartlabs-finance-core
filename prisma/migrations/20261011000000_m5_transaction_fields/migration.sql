-- M5: Add missing Transaction fields per PDF §8
-- This migration adds all the PDF §8 fields to the transactions table

-- Create PaymentMethod enum if not exists
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PaymentMethod') THEN
    CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'CHEQUE', 'MOBILE_MONEY', 'PAYMENT_GATEWAY', 'CARD', 'OTHER');
  END IF;
END $$;

-- Add missing columns to transactions table
ALTER TABLE "transactions" 
  ADD COLUMN IF NOT EXISTS "number" VARCHAR(50),
  ADD COLUMN IF NOT EXISTS "account_id" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "amount" NUMERIC(20,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "currency_code" CHAR(3) NOT NULL DEFAULT 'TZS',
  ADD COLUMN IF NOT EXISTS "project_id" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "department_id" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "cost_centre_id" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "location_id" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "funding_source_id" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "payment_method" "PaymentMethod" NOT NULL DEFAULT 'CASH',
  ADD COLUMN IF NOT EXISTS "supporting_document_id" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "created_by_id" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "submitted_by_id" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "submitted_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "approved_by_id" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "approved_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "posted_by_id" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "posted_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "reversed_by_id" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "reversed_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "voided_by_id" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "voided_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "reversal_reason_id" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "adjusting_entry_id" VARCHAR(255);

-- Add foreign key constraints
ALTER TABLE "transactions" 
  ADD CONSTRAINT "transactions_account_id_fkey" 
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "transactions" 
  ADD CONSTRAINT "transactions_project_id_fkey" 
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "transactions" 
  ADD CONSTRAINT "transactions_department_id_fkey" 
  FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "transactions" 
  ADD CONSTRAINT "transactions_cost_centre_id_fkey" 
  FOREIGN KEY ("cost_centre_id") REFERENCES "cost_centres"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "transactions" 
  ADD CONSTRAINT "transactions_location_id_fkey" 
  FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "transactions" 
  ADD CONSTRAINT "transactions_funding_source_id_fkey" 
  FOREIGN KEY ("funding_source_id") REFERENCES "funding_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "transactions" 
  ADD CONSTRAINT "transactions_currency_code_fkey" 
  FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Note: supporting_document_id references documents table (M12) - FK added in M12
-- ALTER TABLE "transactions" 
--   ADD CONSTRAINT "transactions_supporting_document_id_fkey" 
--   FOREIGN KEY ("supporting_document_id") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "transactions" 
  ADD CONSTRAINT "transactions_created_by_id_fkey" 
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "transactions" 
  ADD CONSTRAINT "transactions_submitted_by_id_fkey" 
  FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "transactions" 
  ADD CONSTRAINT "transactions_approved_by_id_fkey" 
  FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "transactions" 
  ADD CONSTRAINT "transactions_posted_by_id_fkey" 
  FOREIGN KEY ("posted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "transactions" 
  ADD CONSTRAINT "transactions_reversed_by_id_fkey" 
  FOREIGN KEY ("reversed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "transactions" 
  ADD CONSTRAINT "transactions_voided_by_id_fkey" 
  FOREIGN KEY ("voided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "transactions" 
  ADD CONSTRAINT "transactions_reversal_reason_id_fkey" 
  FOREIGN KEY ("reversal_reason_id") REFERENCES "reversal_reason_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "transactions" 
  ADD CONSTRAINT "transactions_adjusting_entry_id_fkey" 
  FOREIGN KEY ("adjusting_entry_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Add unique constraint on organization_id, number
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'transactions_organization_id_number_key'
  ) THEN
    ALTER TABLE "transactions" 
    ADD CONSTRAINT "transactions_organization_id_number_key" 
    UNIQUE ("organization_id", "number");
  END IF;
END $$;

-- Add indexes
CREATE INDEX IF NOT EXISTS "transactions_account_id_idx" ON "transactions"("account_id");
CREATE INDEX IF NOT EXISTS "transactions_project_id_idx" ON "transactions"("project_id");
CREATE INDEX IF NOT EXISTS "transactions_department_id_idx" ON "transactions"("department_id");
CREATE INDEX IF NOT EXISTS "transactions_cost_centre_id_idx" ON "transactions"("cost_centre_id");
CREATE INDEX IF NOT EXISTS "transactions_location_id_idx" ON "transactions"("location_id");
CREATE INDEX IF NOT EXISTS "transactions_funding_source_id_idx" ON "transactions"("funding_source_id");
CREATE INDEX IF NOT EXISTS "transactions_reversal_reason_id_idx" ON "transactions"("reversal_reason_id");
CREATE INDEX IF NOT EXISTS "transactions_adjusting_entry_id_idx" ON "transactions"("adjusting_entry_id");
CREATE INDEX IF NOT EXISTS "transactions_supporting_document_id_idx" ON "transactions"("supporting_document_id");
CREATE INDEX IF NOT EXISTS "transactions_status_date_idx" ON "transactions"("status", "date");

-- Update reversal_reason_codes.id to have default
ALTER TABLE "reversal_reason_codes" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();