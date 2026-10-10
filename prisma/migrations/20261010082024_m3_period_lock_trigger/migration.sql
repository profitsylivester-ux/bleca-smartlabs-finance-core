-- Period Lock Trigger
-- Rejects writes to journal_entries, journal_lines, and transactions when period status = LOCKED

CREATE OR REPLACE FUNCTION check_period_lock()
RETURNS TRIGGER AS $$
DECLARE
    v_period_status "PeriodStatus";
BEGIN
    -- For journal_entries, check the period_id directly
    IF TG_TABLE_NAME = 'journal_entries' THEN
        SELECT status INTO v_period_status
        FROM financial_periods
        WHERE id = NEW.period_id;
    -- For journal_lines, check via entry -> period
    ELSIF TG_TABLE_NAME = 'journal_lines' THEN
        SELECT fp.status INTO v_period_status
        FROM journal_entries je
        JOIN financial_periods fp ON fp.id = je.period_id
        WHERE je.id = NEW.entry_id;
    -- For transactions, check by date to find the containing monthly period
    ELSIF TG_TABLE_NAME = 'transactions' THEN
        SELECT fp.status INTO v_period_status
        FROM financial_periods fp
        WHERE fp.organization_id = NEW.organization_id
          AND fp.start_date <= NEW.date
          AND fp.end_date >= NEW.date
          AND fp.type = 'MONTHLY'
        ORDER BY fp.start_date DESC
        LIMIT 1;
    END IF;

    IF v_period_status = 'LOCKED' THEN
        RAISE EXCEPTION 'Cannot write to period in LOCKED status';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger on journal_entries
DROP TRIGGER IF EXISTS trg_journal_entries_period_lock ON journal_entries;
CREATE TRIGGER trg_journal_entries_period_lock
    BEFORE INSERT OR UPDATE ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION check_period_lock();

-- Trigger on journal_lines
DROP TRIGGER IF EXISTS trg_journal_lines_period_lock ON journal_lines;
CREATE TRIGGER trg_journal_lines_period_lock
    BEFORE INSERT OR UPDATE ON journal_lines
    FOR EACH ROW EXECUTE FUNCTION check_period_lock();

-- Trigger on transactions
DROP TRIGGER IF EXISTS trg_transactions_period_lock ON transactions;
CREATE TRIGGER trg_transactions_period_lock
    BEFORE INSERT OR UPDATE ON transactions
    FOR EACH ROW EXECUTE FUNCTION check_period_lock();