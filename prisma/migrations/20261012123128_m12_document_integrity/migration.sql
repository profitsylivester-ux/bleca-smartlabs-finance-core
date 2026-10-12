-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'DOCUMENT_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'DOCUMENT_DELETED';
ALTER TYPE "AuditAction" ADD VALUE 'DOCUMENT_APPROVAL_SUBMITTED';
ALTER TYPE "AuditAction" ADD VALUE 'LEGAL_HOLD_PLACED';
ALTER TYPE "AuditAction" ADD VALUE 'LEGAL_HOLD_RELEASED';
ALTER TYPE "AuditAction" ADD VALUE 'RETENTION_POLICY_UPDATED';

-- Evidence versions are immutable after insertion, including through direct SQL.
CREATE FUNCTION prevent_document_version_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'document_versions are append-only';
END;
$$;

CREATE TRIGGER document_versions_append_only
BEFORE UPDATE OR DELETE ON document_versions
FOR EACH ROW EXECUTE FUNCTION prevent_document_version_mutation();

-- Permit historical holds and links while allowing only one active hold per
-- entity and one active primary document for any linked entity.
CREATE UNIQUE INDEX legal_holds_one_active_entity_idx
  ON legal_holds (organization_id, entity_type, entity_id)
  WHERE released_at IS NULL;

CREATE UNIQUE INDEX document_links_one_primary_per_entity_idx
  ON document_links (entity_type, entity_id)
  WHERE is_primary = true AND deleted_at IS NULL;
