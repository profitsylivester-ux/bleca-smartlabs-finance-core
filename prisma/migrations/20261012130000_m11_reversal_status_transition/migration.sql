-- A posted entry remains immutable, except for the state transition that marks
-- it reversed after a separate, balanced reversal entry has been posted.
CREATE OR REPLACE FUNCTION prevent_posted_journal_mutation()
RETURNS trigger AS $$
BEGIN
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
      IF OLD.status = 'POSTED'
        AND NEW.status = 'REVERSED'
        AND (to_jsonb(NEW) - ARRAY['status', 'updated_at']) = (to_jsonb(OLD) - ARRAY['status', 'updated_at']) THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'Cannot modify a % journal entry', OLD.status;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
