-- M4: Journal Entry schema changes
-- Add new columns to journal_entries and journal_lines for M4 double-entry core

-- Create reversal_reason_codes table
CREATE TABLE IF NOT EXISTS reversal_reason_codes (
  id VARCHAR(255) NOT NULL PRIMARY KEY,
  organization_id VARCHAR(255) NOT NULL,
  code VARCHAR(50) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(50) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reversal_reason_codes_organization_id_code_key UNIQUE (organization_id, code)
);

CREATE INDEX IF NOT EXISTS reversal_reason_codes_category_is_active_idx ON reversal_reason_codes(category, is_active);
CREATE INDEX IF NOT EXISTS reversal_reason_codes_organization_id_idx ON reversal_reason_codes(organization_id);

-- journal_entries: add new columns for M4
ALTER TABLE journal_entries 
  ADD COLUMN IF NOT EXISTS number VARCHAR(50),
  ADD COLUMN IF NOT EXISTS adjusting_entry_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS reversal_reason_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS reversed_entry_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS submitted_by_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS posted_by_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS reversed_by_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;

-- journal_lines: add new columns for M4
ALTER TABLE journal_lines 
  ADD COLUMN IF NOT EXISTS line_number INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS base_amount NUMERIC(20,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fx_rate NUMERIC(20,10),
  ADD COLUMN IF NOT EXISTS project_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS department_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS cost_centre_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS location_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS funding_source_id VARCHAR(255);

-- Add unique constraint on journal_entries (organization_id, number)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'journal_entries_organization_id_number_key'
  ) THEN
    ALTER TABLE journal_entries 
    ADD CONSTRAINT journal_entries_organization_id_number_key 
    UNIQUE (organization_id, number);
  END IF;
END $$;

-- Add unique constraint on journal_lines (entry_id, line_number)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'journal_lines_entry_id_line_number_key'
  ) THEN
    ALTER TABLE journal_lines 
    ADD CONSTRAINT journal_lines_entry_id_line_number_key 
    UNIQUE (entry_id, line_number);
  END IF;
END $$;

-- Handle case where constraints already exist from db push
-- Drop and recreate if they exist but with different definition

-- Add foreign key constraints
ALTER TABLE journal_entries 
  ADD CONSTRAINT journal_entries_adjusting_entry_id_fkey 
  FOREIGN KEY (adjusting_entry_id) REFERENCES journal_entries(id) 
  ON DELETE SET NULL
  NOT VALID;

ALTER TABLE journal_entries 
  ADD CONSTRAINT journal_entries_reversal_reason_id_fkey 
  FOREIGN KEY (reversal_reason_id) REFERENCES reversal_reason_codes(id) 
  ON DELETE SET NULL
  NOT VALID;

ALTER TABLE journal_entries 
  ADD CONSTRAINT journal_entries_reversed_entry_id_fkey 
  FOREIGN KEY (reversed_entry_id) REFERENCES journal_entries(id) 
  ON DELETE SET NULL
  NOT VALID;

ALTER TABLE journal_entries 
  ADD CONSTRAINT journal_entries_submitted_by_id_fkey 
  FOREIGN KEY (submitted_by_id) REFERENCES users(id) 
  ON DELETE SET NULL
  NOT VALID;

ALTER TABLE journal_entries 
  ADD CONSTRAINT journal_entries_approved_by_id_fkey 
  FOREIGN KEY (approved_by_id) REFERENCES users(id) 
  ON DELETE SET NULL
  NOT VALID;

ALTER TABLE journal_entries 
  ADD CONSTRAINT journal_entries_posted_by_id_fkey 
  FOREIGN KEY (posted_by_id) REFERENCES users(id) 
  ON DELETE SET NULL
  NOT VALID;

ALTER TABLE journal_entries 
  ADD CONSTRAINT journal_entries_reversed_by_id_fkey 
  FOREIGN KEY (reversed_by_id) REFERENCES users(id) 
  ON DELETE SET NULL
  NOT VALID;

ALTER TABLE journal_entries 
  ADD CONSTRAINT journal_entries_voided_by_id_fkey 
  FOREIGN KEY (voided_by_id) REFERENCES users(id) 
  ON DELETE SET NULL
  NOT VALID;

ALTER TABLE journal_lines 
  ADD CONSTRAINT journal_lines_project_id_fkey 
  FOREIGN KEY (project_id) REFERENCES projects(id) 
  ON DELETE SET NULL
  NOT VALID;

ALTER TABLE journal_lines 
  ADD CONSTRAINT journal_lines_department_id_fkey 
  FOREIGN KEY (department_id) REFERENCES departments(id) 
  ON DELETE SET NULL
  NOT VALID;

ALTER TABLE journal_lines 
  ADD CONSTRAINT journal_lines_cost_centre_id_fkey 
  FOREIGN KEY (cost_centre_id) REFERENCES cost_centres(id) 
  ON DELETE SET NULL
  NOT VALID;

ALTER TABLE journal_lines 
  ADD CONSTRAINT journal_lines_location_id_fkey 
  FOREIGN KEY (location_id) REFERENCES locations(id) 
  ON DELETE SET NULL
  NOT VALID;

ALTER TABLE journal_lines 
  ADD CONSTRAINT journal_lines_funding_source_id_fkey 
  FOREIGN KEY (funding_source_id) REFERENCES funding_sources(id) 
  ON DELETE SET NULL
  NOT VALID;

-- Validate foreign keys
ALTER TABLE journal_entries VALIDATE CONSTRAINT journal_entries_adjusting_entry_id_fkey;
ALTER TABLE journal_entries VALIDATE CONSTRAINT journal_entries_reversal_reason_id_fkey;
ALTER TABLE journal_entries VALIDATE CONSTRAINT journal_entries_reversed_entry_id_fkey;
ALTER TABLE journal_entries VALIDATE CONSTRAINT journal_entries_submitted_by_id_fkey;
ALTER TABLE journal_entries VALIDATE CONSTRAINT journal_entries_approved_by_id_fkey;
ALTER TABLE journal_entries VALIDATE CONSTRAINT journal_entries_posted_by_id_fkey;
ALTER TABLE journal_entries VALIDATE CONSTRAINT journal_entries_reversed_by_id_fkey;
ALTER TABLE journal_entries VALIDATE CONSTRAINT journal_entries_voided_by_id_fkey;
ALTER TABLE journal_lines VALIDATE CONSTRAINT journal_lines_project_id_fkey;
ALTER TABLE journal_lines VALIDATE CONSTRAINT journal_lines_department_id_fkey;
ALTER TABLE journal_lines VALIDATE CONSTRAINT journal_lines_cost_centre_id_fkey;
ALTER TABLE journal_lines VALIDATE CONSTRAINT journal_lines_location_id_fkey;
ALTER TABLE journal_lines VALIDATE CONSTRAINT journal_lines_funding_source_id_fkey;

-- Add indexes
CREATE INDEX IF NOT EXISTS journal_entries_adjusting_entry_id_idx ON journal_entries(adjusting_entry_id);
CREATE INDEX IF NOT EXISTS journal_entries_reversed_entry_id_idx ON journal_entries(reversed_entry_id);
CREATE INDEX IF NOT EXISTS journal_entries_reversal_reason_id_idx ON journal_entries(reversal_reason_id);

CREATE INDEX IF NOT EXISTS journal_lines_project_id_idx ON journal_lines(project_id);
CREATE INDEX IF NOT EXISTS journal_lines_department_id_idx ON journal_lines(department_id);
CREATE INDEX IF NOT EXISTS journal_lines_cost_centre_id_idx ON journal_lines(cost_centre_id);
CREATE INDEX IF NOT EXISTS journal_lines_location_id_idx ON journal_lines(location_id);
CREATE INDEX IF NOT EXISTS journal_lines_funding_source_id_idx ON journal_lines(funding_source_id);


-- M4: Journal Entry Balance Check Trigger
-- Enforces that sum(debits) = sum(credits) for each journal entry
-- This runs at the database level, preventing any unbalanced entry from being committed

CREATE OR REPLACE FUNCTION check_journal_entry_balance()
RETURNS trigger AS $$
DECLARE
  v_debit_sum   NUMERIC(20,6);
  v_credit_sum  NUMERIC(20,6);
BEGIN
  -- Only check on INSERT or UPDATE of journal_lines
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    SELECT
      COALESCE(SUM(debit), 0),
      COALESCE(SUM(credit), 0)
    INTO v_debit_sum, v_credit_sum
    FROM journal_lines
    WHERE entry_id = NEW.entry_id;
    
    IF v_debit_sum <> v_credit_sum THEN
      RAISE EXCEPTION 'Journal entry % is unbalanced: debits=% credits=%', NEW.entry_id, v_debit_sum, v_credit_sum;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_journal_entry_balance ON journal_lines;
CREATE TRIGGER trg_journal_entry_balance
  AFTER INSERT OR UPDATE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION check_journal_entry_balance();


-- M4: Journal Entry Immutability Trigger
-- Prevents UPDATE/DELETE on journal_entries and journal_lines when status IN ('POSTED','LOCKED')
-- This is a database-level guarantee that survives any buggy service layer

CREATE OR REPLACE FUNCTION prevent_posted_journal_mutation()
RETURNS trigger AS $$
BEGIN
  -- Check if the parent journal entry is POSTED or LOCKED
  IF TG_TABLE_NAME = 'journal_lines' THEN
    IF EXISTS (
      SELECT 1 FROM journal_entries
      WHERE id = OLD.entry_id
      AND status IN ('POSTED', 'LOCKED')
    ) THEN
      RAISE EXCEPTION 'Cannot modify lines of a % journal entry', 
        (SELECT status FROM journal_entries WHERE id = OLD.entry_id);
    END IF;
  ELSIF TG_TABLE_NAME = 'journal_entries' THEN
    IF OLD.status IN ('POSTED', 'LOCKED') THEN
      RAISE EXCEPTION 'Cannot modify a % journal entry', OLD.status;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_journal_immutability_entries ON journal_entries;
CREATE TRIGGER trg_journal_immutability_entries
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_posted_journal_mutation();

DROP TRIGGER IF EXISTS trg_journal_immutability_lines ON journal_lines;
CREATE TRIGGER trg_journal_immutability_lines
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION prevent_posted_journal_mutation();