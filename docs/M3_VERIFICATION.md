# M3 Verification Guide

This guide provides step-by-step verification for all 5 M3 tasks.

---

## Task 1: Prisma Models + Migrations + Seed

### 1.1 Verify Models Exist
```bash
npx prisma db pull
```
Check that `Account`, `FinancialPeriod`, `OpeningBalance`, and `AccountBalanceSnapshot` models are present.

### 1.2 Verify Migration Applied
```bash
npx prisma migrate status
```
Confirm M3 migration is applied.

### 1.3 Verify Period-Lock Trigger
```sql
-- Run in database console
SELECT * FROM information_schema.triggers 
WHERE trigger_name LIKE '%period_lock%';
```
Trigger should exist on `journal_entries` and `transactions` rejecting writes when period status = `LOCKED`.

### 1.4 Verify CoA Seed (PDF §7)
```bash
curl -X POST http://localhost:3000/api/v1/accounts/seed-pdf7 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>"
```
Response: `200` with seeded accounts including dormant Phase 2 accounts:
- `INVENTORY`, `EQUIPMENT`, `FUTURE_INVESTMENT`
- SaaS revenue, token revenue, component revenue
- Salaries, hardware/prototyping expenses

---

## Task 2: Chart of Accounts API

### 2.1 List Accounts (Hierarchical)
```bash
curl -X GET http://localhost:3000/api/v1/accounts \
  -H "Authorization: Bearer <token>"
```
- Returns hierarchical tree
- Each account has: `code`, `name`, `type`, `normalBalance`, `postable`, `lockable`, `reconcilable`, `documentRequired`, `validatedByQualifiedAccountant`

### 2.2 Create Account (Validation)
```bash
curl -X POST http://localhost:3000/api/v1/accounts \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -H "Idempotency-Key: test-1" \
  -d '{"code":"1001","name":"Cash","type":"ASSET","normalBalance":"DEBIT","parentId":null}'
```
- Success: `201` with created account
- Fail duplicate code: `409`
- Fail invalid parent: `400`
- Fail normal balance mismatch type: `400`

### 2.3 Update Account
```bash
curl -X PATCH http://localhost:3000/api/v1/accounts/<id> \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -H "Idempotency-Key: test-2" \
  -d '{"name":"Cash - Main"}'
```

### 2.4 Delete Account (Lock Instead)
```bash
curl -X DELETE http://localhost:3000/api/v1/accounts/<id> \
  -H "Authorization: Bearer <token>"
```
- If lines exist: returns `409`, account locked (`isLocked=true`)
- If no lines: returns `204`

---

## Task 3: Financial Periods API

### 3.1 List/Create Periods
```bash
curl -X GET http://localhost:3000/api/v1/periods \
  -H "Authorization: Bearer <token>"

curl -X POST http://localhost:3000/api/v1/periods \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -H "Idempotency-Key: period-1" \
  -d '{"name":"Jan 2026","startDate":"2026-01-01","endDate":"2026-01-31","type":"MONTHLY"}'
```

### 3.2 Status Transitions
```bash
# Open
curl -X POST http://localhost:3000/api/v1/periods/<id>/open \
  -H "Authorization: Bearer <token>"

# Close
curl -X POST http://localhost:3000/api/v1/periods/<id>/close \
  -H "Authorization: Bearer <token>"

# Lock
curl -X POST http://localhost:3000/api/v1/periods/<id>/lock \
  -H "Authorization: Bearer <token>"
```
- Valid transitions: `DRAFT` → `OPEN` → `CLOSED` → `LOCKED`
- Invalid transitions return `400`

### 3.3 Reopen Flow
```bash
# Request reopen (requires approval)
curl -X POST http://localhost:3000/api/v1/periods/<id>/reopen-request \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"reason":"Adjustment needed"}'

# Approve reopen (increments reopenCount, sets REOPENED)
curl -X POST http://localhost:3000/api/v1/periods/<id>/reopen-approve \
  -H "Authorization: Bearer <token>"
```

### 3.4 Auto-Generate FY Periods
```bash
curl -X POST http://localhost:3000/api/v1/periods/generate-fy \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -H "Idempotency-Key: fy-2026" \
  -d '{"fiscalYear":2026,"includeMonthly":true,"includeQuarterly":true,"includeAnnual":true}'
```
- Creates 12 monthly + 4 quarterly + 1 annual = 17 periods
- No overlap between periods
- All status `DRAFT`

---

## Task 4: Opening Balances API

### 4.1 Create Opening Balance (Defaults to Unverified)
```bash
curl -X POST http://localhost:3000/api/v1/opening-balances \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -H "Idempotency-Key: ob-1" \
  -d '{"accountId":"<account-id>","periodId":"<period-id>","amount":3900000,"currency":"TZS","source":"Opening balance per audited FS"}'
```
- Response: `201` with `isUnverified: true`, `verificationStatus: "UNVERIFIED"`

### 4.2 Verify Opening Balance
```bash
curl -X POST http://localhost:3000/api/v1/opening-balances/<id>/verify \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"note":"Verified by qualified accountant per IFRS","verifiedByQualifiedAccountant":true}'
```
- Response: `200` with `isUnverified: false`, `verificationStatus: "VERIFIED"`

### 4.3 Validation Checks
- Cannot create without `source`: `400`
- Cannot post to non-postable account: `400`

---

## Task 5: UI Screens + Integration Tests

### 5.1 Chart of Accounts UI
Navigate to: `http://localhost:3000/accounting/chart-of-accounts`
- Tree view with expand/collapse
- Click account → detail drawer opens
- Create/edit/delete buttons functional

### 5.2 Opening Balances UI
Navigate to: `http://localhost:3000/accounting/opening-balances`
- List shows unverified badge on unverified entries
- Verify action opens modal requiring note + qualified accountant checkbox
- After verify: badge changes to verified

### 5.3 Periods UI
Navigate to: `http://localhost:3000/periods`
- List with status badges (DRAFT/OPEN/CLOSED/LOCKED/REOPENED)
- Actions: Open, Close, Lock, Reopen Request
- Click period → detail page at `/periods/[id]`
- Detail page shows reopen flow with approval

### 5.4 Run Integration Tests
```bash
npm run test:integration
```
Expected passing tests:
- Account code uniqueness
- Cannot post to non-postable account
- Period auto-generation covers year without overlap
- Posting into LOCKED period rejected by **trigger**
- Reopen requires approved request + increments `reopenCount`
- Opening balances default unverified
- Verify requires note
- Historical balance requires `source`

---

## Summary Checklist

| Task | Verified |
|------|----------|
| 1. Prisma models, migrations, seed, trigger | ☐ |
| 2. CoA CRUD + seed endpoint | ☐ |
| 3. Periods lifecycle + auto-generation | ☐ |
| 4. Opening balances + verification | ☐ |
| 5. UI screens + integration tests | ☐ |