# M4 Verification Guide

This guide provides step-by-step verification for all M4 features: double-entry core, general ledger, trial balance, and financial statements.

---

## Task 9: Integration Tests + Verification Doc

### 9.1 Balanced Journal Entry Can Be Posted
```bash
# Create a balanced entry (debits = credits)
curl -X POST http://localhost:3000/api/v1/journal-entries \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -H "Idempotency-Key: balanced-1" \
  -d '{"lines":[{"account":"1001","description":"Test deposit","debit":1000,"credit":0},{"account":"2001","description":"Test credit","debit":0,"credit":1000}],"periodId":"<id>","submitterId":"<user>","approverId":"<user>"}'
```
- Response: `201` with posted entry
- Status flows: `DRAFT` → `SUBMITTED` → `APPROVED` → `POSTED`

### 9.2 Unbalanced Entry Rejected
```bash
# Create unbalanced entry (debits ≠ credits)
curl -X POST http://localhost:3000/api/v1/journal-entries \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -H "Idempotency-Key: unbalanced-1" \
  -d '{"lines":[{"account":"1001","description":"Test","debit":500,"credit":0}],"periodId":"<id>","submitterId":"<user>","approverId":"<user>"}'
```
- Expected: `400` or posting rejected by balance check
- Entry remains in `DRAFT` status

### 9.3 Locked-Period Posting Rejected by DB Trigger
```bash
# Lock the period and attempt to post
curl -X POST http://localhost:3000/api/v1/periods/<id>/lock \
  -H "Authorization: Bearer <token>"
# Then attempt to post to locked period
curl -X POST http://localhost:3000/api/v1/journal-entries/[id]/post \
  -H "Authorization: Bearer <token>"
```
- Expected: `400` or `409` — posting rejected
- DB trigger enforces `sum(debits) = sum(credits)` per entry

### 9.4 Posted Entry Immutability (UPDATE/DELETE Rejected by Trigger)
```bash
# Attempt UPDATE on posted entry
curl -X PATCH http://localhost:3000/api/v1/journal-entries/[id] \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"status":"CANCELLED"}'
```
- Expected: `400` — UPDATE rejected when `status IN ('POSTED','LOCKED')`

```bash
# Attempt DELETE on posted entry
curl -X DELETE http://localhost:3000/api/v1/journal-entries/[id] \
  -H "Authorization: Bearer <token>"
```
- Expected: `400` — DELETE rejected when `status IN ('POSTED','LOCKED')`

### 9.5 Reversal Traceability (Linked Opposite Entry; Original Visible)
```bash
# Create and post a balanced entry, then reverse it
curl -X POST http://localhost:3000/api/v1/journal-entries/[id]/reverse \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"reasonCode":"FRAUD","evidence":"Test reversal","fullAmount":true}'
```
- Response: new entry created with `reversalOfId` pointing to original
- Original entry still visible with `reversedAt` timestamp
- Original lines remain unchanged; new entry has opposite debit/credit

### 9.6 Partial Reversal Residual Correctness
```bash
# Reverse only half the amount
curl -X POST http://localhost:3000/api/v1/journal-entries/[id]/reverse \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"reasonCode":"FRAUD","evidence":"Partial reversal","fullAmount":false,"amount":500}'
```
- New entry created for 50% of original amount
- Residual balance on original entry adjusted
- Trial balance reflects corrected balances

### 9.7 Trial Balance Debits = Credits
```bash
curl -X GET "http://localhost:3000/api/v1/trial-balance?asAtDate=2026-12-31&currency=TZS" \
  -H "Authorization: Bearer <token>"
```
- Response: account, type, debit, credit, baseCurrencyDebit, baseCurrencyCredit
- Badge/indicator: **debits = credits**
- Sum of all debit column = sum of all credit column

### 9.8 Income Statement Ties to GL
```bash
# Get income statement for a period
curl -X GET "http://localhost:3000/api/v1/reports/income-statement?periodId=<id>&currency=TZS" \
  -H "Authorization: Bearer <token>"
```
- Returns revenue by subcategory, expense by subcategory, net surplus/deficit
- Cross-reference with `GET /api/v1/general-ledger` for same period
- GL totals for revenue/expense accounts match income statement figures

### 9.9 Balance Sheet Balances
```bash
curl -X GET "http://localhost:3000/api/v1/reports/balance-sheet?asAtDate=2026-12-31&currency=TZS" \
  -H "Authorization: Bearer <token>"
```
- Returns assets, liabilities, equity by subcategory
- **Equation verified**: assets = liabilities + equity
- Each subcategory totals cross-check with GL

### 9.10 Snapshot Truncation + Rebuild Reproduces Identical Figures
```bash
# Rebuild balance snapshots
curl -X POST http://localhost:3000/api/v1/admin/rebuild-balance-snapshots \
  -H "Authorization: Bearer <token>"
```
- Truncates `account_balance_snapshots`, recomputes from `JournalLine`
- Run twice: identical figures (idempotent)
- Compare snapshots before/after rebuild — all debits/credits match

---

## Commands

```bash
npm run test:integration
```
- Runs all integration tests covering M4 features:
  - Unbalanced entry cannot post
  - Locked-period post rejected by trigger
  - Poster ≠ submitter rejected
  - Posting without approval rejected
  - Posted entry UPDATE/DELETE rejected by trigger
  - Reversal produces linked opposite entry, original visible
  - Partial reversal residual balance correct
  - Trial balance debits = credits
  - Balance sheet balances
  - Income statement ties to GL
  - Snapshot truncation + rebuild reproduces identical figures

```bash
npx tsc --noEmit
```
- Type-checks all source files; no implicit `any`; satisfies strict mode

```bash
npm run lint
```
- Runs ESLint/Prettier across the codebase; no errors or warnings

---

## Sign-off Checklist

| Task | Verified |
|------|----------|
| 9.1 Balanced journal entry can be posted | ☐ |
| 9.2 Unbalanced entry rejected | ☐ |
| 9.3 Locked-period posting rejected by DB trigger | ☐ |
| 9.4 Posted entry immutability (UPDATE/DELETE rejected) | ☐ |
| 9.5 Reversal traceability (linked opposite entry; original visible) | ☐ |
| 9.6 Partial reversal residual correctness | ☐ |
| 9.7 Trial balance debits = credits | ☐ |
| 9.8 Income statement ties to GL | ☐ |
| 9.9 Balance sheet balances | ☐ |
| 9.10 Snapshot truncation + rebuild reproduces identical figures | ☐ |
| Integration tests (`npm run test:integration`) all passing | ☐ |
| Type-check (`npx tsc --noEmit`) no errors | ☐ |
| Lint (`npm run lint`) no errors/warnings | ☐ |