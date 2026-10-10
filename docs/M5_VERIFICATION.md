# M5 Verification Guide

## How to Verify M5 Transaction Lifecycle & Workflow State Machine

### Prerequisites
1. Run database migrations: `npx prisma migrate reset --force`
2. Seed database: `tsx prisma/seed.ts`
3. Start development server: `npm run dev`

### Manual Verification Steps

#### 1. Transaction List UI (`/transactions`)
- Navigate to `/transactions`
- Verify: Filter by status, date range, project, department, amount
- Verify: Sort by date, reference, status, amount
- Verify: Search by description/reference
- Verify: Export CSV button works
- Verify: Pagination works
- Verify: "New Transaction" button visible only with `TRANSACTIONS.CREATE` permission
- Verify: View/Adjust/Reverse links appear in Actions column

#### 2. Create Transaction (`/transactions/new`)
- Navigate to `/transactions/new`
- Verify all PDF §8 fields present:
  - Date (required)
  - Description (required)
  - Reference (optional, auto-generated)
  - Account (required, only postable ACTIVE accounts)
  - Amount (required, > 0)
  - Currency Code (required, 3 chars)
  - Payment Method (required, dropdown)
  - Project (optional)
  - Department (optional)
  - Cost Centre (optional)
  - Funding Source (optional)
  - Supporting Document (optional)
- Submit form → redirects to detail page

#### 3. Transaction Detail (`/transactions/[id]`)
- Verify: Timeline shows status transitions (DRAFT→SUBMITTED→APPROVED→POSTED→LOCKED→ADJUSTED/REVERSED)
- Verify: Document links (supporting document, journal entry)
- Verify: Journal entry preview with lines, balance
- Verify: Audit trail shows all actions with metadata
- Verify: Action buttons only show for legal transitions:
  - DRAFT: Submit, Cancel
  - SUBMITTED: Approve, Reject
  - APPROVED: Post
  - POSTED/LOCKED: Adjust, Reverse
  - ADJUSTED: Post, Reverse

#### 4. Adjust Transaction (`/transactions/[id]/adjust`)
- Only accessible for POSTED/LOCKED transactions
- Verify: Requires reason code (ADJUSTMENT category)
- Verify: Evidence document ID field
- Verify: Description required
- Verify: Amount required
- Submit creates new ADJUSTED transaction linked to original

#### 5. Reverse Transaction (`/transactions/[id]/reverse`)
- Only accessible for POSTED/LOCKED transactions
- Verify: Requires reason code (REVERSAL category)
- Verify: Evidence document ID field
- Verify: Description required
- Verify: Original transaction ID pre-filled
- Submit creates REVERSED transaction linked to original
- Original remains visible with POSTED status

### API Verification

#### End-to-End Lifecycle
```bash
# 1. Create
POST /api/v1/transactions { date, description, accountId, amount, currencyCode, paymentMethod }

# 2. Submit
POST /api/v1/transactions/:id/submit (with Idempotency-Key)

# 3. Approve
POST /api/v1/transactions/:id/approve (with Idempotency-Key)

# 4. Post
POST /api/v1/transactions/:id/post (with Idempotency-Key)
# → Creates journal entry, updates balances

# 5. Adjust
POST /api/v1/transactions/:id/adjust { reason, evidenceDocumentId } (with Idempotency-Key)

# 6. Reverse
POST /api/v1/transactions/:id/reverse { reason, evidenceDocumentId, originalTransactionId } (with Idempotency-Key)
```

#### Idempotency
- Repeat any mutating request with same `Idempotency-Key` header
- Verify: Returns same response without side effects
- Check: `outcome.kind === 'REPLAYED'`

#### Illegal Transitions
- Attempt: DRAFT → POSTED (skipping SUBMITTED/APPROVED)
- Verify: Rejected with validation error
- Check audit log: `result: FAILURE`, `errorMessage` contains "Illegal state transition", `metadata.isLegalTransition: false`

#### Edit/Delete Restrictions
- APPROVED/POSTED transactions cannot be edited via service
- APPROVED/POSTED transactions cannot be deleted at DB level (trigger enforced)
- Verify: `txService.update()` throws for APPROVED/POSTED
- Verify: `DELETE FROM transactions WHERE id = '...'` throws for APPROVED/POSTED

### Database Verification
```sql
-- Check transaction state machine
SELECT status, COUNT(*) FROM transactions GROUP BY status;

-- Check audit trail
SELECT action, entity_type, result, created_at 
FROM audit_logs 
WHERE entity_type = 'JOURNAL_ENTRY' 
ORDER BY created_at DESC;

-- Check journal entry linkage
SELECT t.id, t.status, t.reference, je.number as je_number, je.status as je_status
FROM transactions t
LEFT JOIN journal_entries je ON je.transaction_id = t.id;

-- Check adjustment/reversal linkage
SELECT t1.id as original, t1.status, t2.id as linked, t2.status, t2.adjusting_entry_id
FROM transactions t1
LEFT JOIN transactions t2 ON t2.adjusting_entry_id = t1.id;
```

### Automated Tests
```bash
# Run integration tests
npm run test:integration

# Run all tests
npm test

# Type check
npx tsc --noEmit

# Lint
npm run lint
```

### Expected Test Results
All integration tests should pass:
- M5 Transaction Lifecycle (10 tests)
- M5 Audit Trail Verification (1 test)
- All existing integration tests (138 tests)

### Known Issues to Address
1. Service layer validation for APPROVED/POSTED edit restriction
2. Database trigger for APPROVED/POSTED delete restriction
3. Journal entry creation on POST
4. Adjustment/reversal transaction creation and linking
5. Idempotency key handling in tests
6. Audit trail for illegal transitions

### Verification Checklist
- [ ] Transaction list UI loads with filters, sort, pagination, export
- [ ] Create transaction form has all PDF §8 fields
- [ ] Transaction detail shows timeline, documents, journal preview, audit trail
- [ ] Adjust/Reverse screens only show for legal states
- [ ] Adjust/Reverse require reason code + evidence + link to original
- [ ] E2E lifecycle: create→submit→approve→post→adjust→reverse completes
- [ ] APPROVED/POSTED cannot be edited (service + DB)
- [ ] POST is idempotent with same key
- [ ] Reversal links to original, preserves visibility
- [ ] Illegal transitions rejected and audited
- [ ] All integration tests pass
- [ ] TypeScript compiles without errors
- [ ] Lint passes