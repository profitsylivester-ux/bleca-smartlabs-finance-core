-- Database-level backstops for supplier payment-detail security.
-- The workflow also enforces these conditions in its transactional services.

ALTER TABLE "supplier_bank_detail_change_requests"
  ADD CONSTRAINT "supplier_bank_change_requester_verifier_distinct"
    CHECK ("verifier_id" IS NULL OR "verifier_id" <> "requested_by_id"),
  ADD CONSTRAINT "supplier_bank_change_requester_approver_distinct"
    CHECK ("approver_id" IS NULL OR "approver_id" <> "requested_by_id"),
  ADD CONSTRAINT "supplier_bank_change_verifier_approver_distinct"
    CHECK ("verifier_id" IS NULL OR "approver_id" IS NULL OR "verifier_id" <> "approver_id");

CREATE UNIQUE INDEX "supplier_bank_details_one_active_primary"
  ON "supplier_bank_details" ("supplier_id")
  WHERE "is_active" = TRUE AND "is_primary" = TRUE;

CREATE FUNCTION "prevent_supplier_bank_detail_delete"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Supplier bank detail history is immutable; deactivate or supersede the record instead.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "supplier_bank_details_no_hard_delete"
  BEFORE DELETE ON "supplier_bank_details"
  FOR EACH ROW EXECUTE FUNCTION "prevent_supplier_bank_detail_delete"();
