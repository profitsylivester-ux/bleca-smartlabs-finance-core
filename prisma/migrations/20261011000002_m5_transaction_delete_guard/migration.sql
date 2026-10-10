-- M5: Prevent deletion of APPROVED and POSTED transactions at database level
-- This is a database-level guarantee that survives any buggy service layer

CREATE OR REPLACE FUNCTION prevent_approved_posted_transaction_deletion()
RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('APPROVED', 'POSTED') THEN
    RAISE EXCEPTION 'Cannot delete a % transaction', OLD.status;
  END IF;
  
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_transaction_delete_guard ON transactions;
CREATE TRIGGER trg_transaction_delete_guard
  BEFORE DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION prevent_approved_posted_transaction_deletion();