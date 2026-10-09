-- ============================================================================
-- Audit trail guards
--
-- These are the guarantees PHASE_1_PLAN.md 7.3 promises. They live in SQL
-- because they must survive a buggy service layer, a careless migration and a
-- SQL injection. A Postgres privilege alone would not be enough: a table owner
-- holds implicit privileges that cannot be revoked from itself.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Genesis row for the chain head.
--
-- The head is a single mutable row. Writers take SELECT ... FOR UPDATE on it,
-- which serialises concurrent audit appends. That serialisation is what makes the
-- chain gap-free: an aborted transaction rolls back the audit row and the head
-- update together, so a sequence number can never be consumed by a lost write.
--
-- '' is the genesis sentinel for previous_hash.
-- ---------------------------------------------------------------------------
INSERT INTO audit_chain_head (id, sequence, entry_hash, updated_at)
VALUES (1, 0, '', now())
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Append-only enforcement.
--
-- UPDATE and DELETE are rejected unconditionally, and so is TRUNCATE, which is
-- statement-level and would otherwise slip past a row-level trigger pair.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bleca_audit_logs_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'audit_logs is append-only (PDF 54): % is not permitted on audit_logs', TG_OP
    USING ERRCODE = 'raise_exception',
          HINT = 'History is corrected by recording a new entry, never by mutating an old one.';
END;
$$;

CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION bleca_audit_logs_append_only();

CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION bleca_audit_logs_append_only();

CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION bleca_audit_logs_append_only();

-- ---------------------------------------------------------------------------
-- 3. Chain-link enforcement.
--
-- An inserted audit row must chain from the CURRENT head and must carry the next
-- sequence number. This is what makes forgery and gap-splicing impossible: a
-- row whose previous_hash does not match the head cannot be written at all, even
-- with direct table access.
--
-- The writer MUST therefore hold the head lock before inserting, and MUST update
-- the head inside the same transaction. That contract is lib/audit/chain.ts and
-- it is asserted by the integration suite.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bleca_audit_logs_enforce_chain_link()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  head_sequence BIGINT;
  head_hash     TEXT;
BEGIN
  SELECT sequence, entry_hash INTO head_sequence, head_hash
    FROM audit_chain_head
   WHERE id = 1
   FOR UPDATE;

  IF head_sequence IS NULL THEN
    RAISE EXCEPTION 'audit_chain_head row is missing; the audit chain cannot be extended'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.sequence <> head_sequence + 1 THEN
    RAISE EXCEPTION
      'audit chain sequence gap: expected %, got %', head_sequence + 1, NEW.sequence
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.previous_hash IS DISTINCT FROM head_hash THEN
    RAISE EXCEPTION
      'audit chain link mismatch: entry % does not chain from the current head', NEW.sequence
      USING ERRCODE = 'raise_exception',
            HINT = 'previous_hash must equal audit_chain_head.entry_hash for the row you locked.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_logs_chain_link
  BEFORE INSERT ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION bleca_audit_logs_enforce_chain_link();

-- ---------------------------------------------------------------------------
-- 4. Entry shape.
--
-- Cheap structural checks that make a corrupt write fail loudly at the database
-- rather than silently at the next chain verification.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bleca_audit_logs_enforce_shape()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.entry_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'entry_hash must be 64 lowercase hex characters, got %', NEW.entry_hash
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.signature IS NULL OR length(NEW.signature) < 43 THEN
    RAISE EXCEPTION 'audit entry % has no usable signature; an unsigned audit entry is not acceptable', NEW.sequence
      USING ERRCODE = 'raise_exception',
            HINT = 'Sign with the HMAC key for the entry''s period (AUDIT_HMAC_KEY).';
  END IF;

  IF NEW.occurred_at IS NULL OR NEW.recorded_at IS NULL THEN
    RAISE EXCEPTION 'audit entry % must carry both occurred_at and recorded_at', NEW.sequence
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.description IS NULL OR length(trim(NEW.description)) = 0 THEN
    RAISE EXCEPTION 'audit entry % has no description', NEW.sequence
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_logs_shape
  BEFORE INSERT ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION bleca_audit_logs_enforce_shape();

-- ---------------------------------------------------------------------------
-- 5. Least-privilege runtime role.
--
-- Production must connect as bleca_app rather than as the table owner, so that
-- the privilege layer below is real rather than decorative. Created NOLOGIN on
-- purpose: enabling LOGIN and setting a password is an operator action done
-- through the platform secret store, never a value committed to this repository.
--
-- Local development connects as the owner (see docs/security.md), which is why
-- the integration suite asserts the TRIGGER rather than the grants: the trigger
-- is the control that holds in every environment.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bleca_app') THEN
    CREATE ROLE bleca_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO bleca_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bleca_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bleca_app;

-- The one table the application must never be able to mutate.
REVOKE UPDATE, DELETE ON audit_logs FROM bleca_app;
REVOKE TRUNCATE ON audit_logs FROM bleca_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bleca_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO bleca_app;

-- ---------------------------------------------------------------------------
-- 6. Live sessions are evidence.
--
-- Session and login telemetry are the only identity data that may be hard
-- deleted, and only after their retention window (PHASE_1_PLAN.md 3.8.9). This
-- trigger refuses to delete a session that is still live, so a bug cannot destroy
-- evidence of an active session.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bleca_sessions_guard_live_rows()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.revoked_at IS NULL AND OLD.absolute_expires_at > now() THEN
    RAISE EXCEPTION
      'refusing to delete a live session (id=%, absolute_expires_at=%)', OLD.id, OLD.absolute_expires_at
      USING ERRCODE = 'raise_exception',
            HINT = 'Revoke the session (set revoked_at) and let retention expiry remove it.';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER sessions_no_live_delete
  BEFORE DELETE ON sessions
  FOR EACH ROW EXECUTE FUNCTION bleca_sessions_guard_live_rows();