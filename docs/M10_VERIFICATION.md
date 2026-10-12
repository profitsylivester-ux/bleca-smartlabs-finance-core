# M10 verification

## Database and tests

The M10 schema is in `20261012103656_m10_parties_credit`. Two companion migrations add the database guarantees Prisma cannot express and soft-delete timestamps for contacts and addresses:

- `20261012104500_m10_bank_detail_guards`
- `20261012105018_m10_party_contact_soft_delete`

Apply them with `npx prisma migrate deploy` in each environment. For local schema work, use `npx prisma migrate dev --name m10_parties_credit`.

Run `npm run typecheck` and `npm run test:integration`. The integration suite covers credit-limit holds, release reason/audit, maker-checker, previous bank values, payment blocking, evidence ID validation, notifications, stage audits, database hard-delete rejection, and aging-to-ledger reconciliation.

## Supplier bank change review

1. Create an active, approved supplier and assign an active primary bank detail when one already exists.
2. `POST /api/v1/suppliers/:id/bank-details` with an idempotency key, proposed account data, and an evidence document ID. The endpoint encrypts the account number, snapshots the current account in `previousValues`, queues in-app and email notifications for active Finance Officer and CEO users, and creates a pending request.
3. Confirm `assertSupplierPaymentAllowed` rejects payments while any of `PENDING`, `VERIFICATION_PENDING`, or `APPROVAL_PENDING` exists.
4. A different user calls `/bank-detail-changes/:changeId/verify`; a third user calls `/approve`. Approval deactivates the prior row and appends a new primary row. Rejection leaves the old row untouched and releases the payment block.
5. `DELETE` against any supplier bank detail is rejected by a PostgreSQL trigger. The requester, verifier, and approver must be distinct, enforced both in the workflow and by database checks.

## Customer credit review

M11 invoice creation must call `evaluateCustomerInvoiceCredit` in its invoice transaction before saving an invoice. On a limit breach it commits the hold and omits the invoice write. M11 must also write the invoice journal entry ID and open amount to `CustomerReceivable` so aging can reconcile to posted receivable lines.

Credit release is an approval action (`CUSTOMERS.APPROVE`), requires a reason, records who requested and approved it, and restores the status the customer had before the hold.

## Follow-on module dependencies

M11 has not introduced invoice, payment, or payment-allocation models yet. M10 therefore provides the customer receivable subledger and the payment/credit guard services for M11 to call; the integration test verifies aging against a linked posted receivable journal entry. Automated customer email reminders depend on the outbound mail and scheduling service, which is not present yet.

M12 has not introduced the document store, so bank-change requests require a non-empty evidence document ID but cannot verify that the ID resolves to an uploaded document yet. M13 has not introduced `TaxObligation`, so supplier tax links retain the future obligation ID without a foreign key until that model lands.
