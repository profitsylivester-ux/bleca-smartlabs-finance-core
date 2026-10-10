# M2 Verification Guide

This document provides step-by-step verification procedures for all M2 deliverables. Run these checks after deploying to confirm that Iventika/Uzanite are usable, TZS/USD/EUR/GBP are configured, FX conversion is reproducible, and unauthorised master-data edits are rejected and audited.

---

## Prerequisites

- Application deployed and running
- Database migrated to latest schema (includes M2 tables)
- Seeded with reference data (run `npm run db:seed` or equivalent)
- At least one CEO user and one Finance Officer user exist
- CEO user has MFA enrolled (required by AuthPolicy)

---

## 1. Organisation Setup Verification

### 1.1 Verify Organisation Root

**Steps:**
1. Sign in as CEO
2. Navigate to **Settings → Organisation**
3. Verify the following fields are populated:
   - Code: `BLECA`
   - Name: `BLECA SmartLabs`
   - Registration Status: `NOT_REGISTERED`
   - Base Currency: `TZS`
   - Fiscal Year Start: Month 1 (January)
   - Fiscal Year End: Day 31

**Expected:** All fields display correctly. TIN is nullable (shows as empty).

### 1.2 Verify Locations

**Steps:**
1. Navigate to **Master Data → Locations**
2. Verify at least one location exists (seeded or created)
3. Click **Add location** and create a new location:
   - Code: `TEST-LOC`
   - Name: `Test Location`
   - Type: `UNIVERSITY_FACILITY`
   - Permission Reference: `University MoU #2024-001`
   - Timezone: `Africa/Dar_es_Salaam`
4. Submit and verify it appears in the list
5. Verify the change request was created (check **Master Data → History**)

**Expected:** Location created via change request, appears in list after approval.

### 1.3 Verify Departments

**Steps:**
1. Navigate to **Master Data → Departments**
2. Click **Add department** and create:
   - Code: `TEST-DEPT`
   - Name: `Test Department`
3. Submit and verify in list

### 1.4 Verify Cost Centres

**Steps:**
1. Navigate to **Master Data → Cost Centres**
2. Click **Add cost centre** and create:
   - Code: `TEST-CC`
   - Name: `Test Cost Centre`
   - Department: Select the department created above
3. Submit and verify in list

---

## 2. Projects & Funding Sources Verification

### 2.1 Verify Seeded Projects

**Steps:**
1. Navigate to **Master Data → Projects**
2. Verify both projects exist:
   - `IVENTIKA` — Iventika research and development project (ACTIVE)
   - `UZANITE` — Uzanite infrastructure project (ACTIVE)
3. Verify each has:
   - Start date: 2024-01-01
   - End dates: 2026-12-31 (Iventika), 2027-06-30 (Uzanite)
   - Is Active: Yes

### 2.2 Verify Seeded Funding Sources

**Steps:**
1. Navigate to **Master Data → Funding Sources**
2. Verify both exist:
   - `UNRESTRICTED` — Unrestricted Funds (UNRESTRICTED, not restricted)
   - `RESTRICTED-GRANT` — Restricted Grant (RESTRICTED_GRANT, restricted)
3. Click on `RESTRICTED-GRANT` and verify restrictions:
   - Allowed Projects: `IVENTIKA`, `UZANITE`
   - Allowed Cost Categories: `PERSONNEL`, `EQUIPMENT`, `TRAVEL`

### 2.3 Test Restricted Funding Scope Enforcement

**Steps:**
1. Create a journal entry or transaction using `RESTRICTED-GRANT`
2. Try to assign it to a project NOT in allowed list (if any exists)
3. Verify the system rejects or warns about the scope violation

**Expected:** Restricted funding sources enforce project and cost category constraints.

---

## 3. Currencies & FX Library Verification

### 3.1 Verify Seeded Currencies

**Steps:**
1. Navigate to **Master Data → Currencies**
2. Verify all four currencies exist:
   - `TZS` — Tanzanian Shilling (TSh) — Base, FIAT, 2 decimals, Active
   - `USD` — US Dollar ($) — FIAT, 2 decimals, Active
   - `EUR` — Euro (€) — FIAT, 2 decimals, Active
   - `GBP` — British Pound (£) — FIAT, 2 decimals, Active

### 3.2 Verify Exchange Rate Entry

**Steps:**
1. Navigate to **Master Data → Exchange Rates**
2. Click **Add exchange rate** and create:
   - Base Currency: `USD`
   - Quote Currency: `TZS`
   - Rate Date: Today's date
   - Rate: `2500.000000` (6 decimal places)
   - Source: `MANUAL`
   - FX Difference Treatment: `EXPENSE`
3. Submit and verify in list

### 3.3 Verify FX Conversion Reproducibility

**Steps:**
1. Create a test transaction in USD (e.g., $100.00)
2. Verify the system converts to TZS using the rate from step 3.2
3. Expected TZS amount: `250,000.00` (100 × 2500)
4. Verify the FX difference account is posted to EXPENSE (per treatment)

**Automated Test:** Run integration test `fx-conversion.test.ts`:
```bash
npm run test:integration -- fx-conversion
```
All 14 tests should pass, including:
- Idempotent rate import (duplicate rejection)
- Historical rate lookup by transaction date
- Configurable rounding
- FX difference treatment (EXPENSE/INCOME/SUSPENSE)

---

## 4. Master Data Change Requests Verification

### 4.1 Verify Approval-Gated Edits

**Steps:**
1. Sign in as **Finance Officer** (cannot approve)
2. Navigate to **Master Data → Locations**
3. Click **Add location** and submit a new location
4. Verify:
   - Change request created with status `PENDING_APPROVAL`
   - Location does NOT appear in the active list yet
5. Navigate to **Master Data → History**
6. Verify the change request shows:
   - Entity: `LOCATION`
   - Status: `PENDING_APPROVAL`
   - Requested by: Finance Officer name

### 4.2 Verify Approval Flow

**Steps:**
1. Sign in as **CEO** (final approver)
2. Navigate to **Master Data → History**
3. Find the pending change request from step 4.1
4. Click **Approve** (with idempotency key)
5. Verify:
   - Status changes to `APPROVED`
   - `approvedBy` = CEO
   - `approvedAt` timestamp set
6. Navigate to **Master Data → Locations**
7. Verify the new location now appears in the active list

### 4.3 Verify Version Snapshots

**Steps:**
1. In **Master Data → History**, click on the approved change request
2. Verify a version snapshot was created:
   - Version number: 1
   - Snapshot contains the proposed changes
   - `effectiveFrom` = approval timestamp (or effectiveDate if set)
   - `changedFields` shows what changed

### 4.4 Verify Effective Dating

**Steps:**
1. Create a change request with `effectiveDate` = tomorrow
2. Approve as CEO
3. Verify the version has `effectiveFrom` = the effectiveDate
4. Create another with `expiresAt` = 30 days from now
5. Approve and verify version has `effectiveTo` = expiresAt

### 4.5 Verify Audit on Rejected Changes

**Steps:**
1. Sign in as Finance Officer
2. Create a change request (e.g., new department)
3. Sign in as CEO
4. Navigate to **Master Data → History**
5. Click **Reject** with reason: "Insufficient budget justification"
6. Verify:
   - Status changes to `REJECTED`
   - Reason includes rejection reason
   - NO version snapshot created
6. Check audit log (via API or admin UI):
   - Entry exists for the rejection
   - Action: `CONFIGURATION_CHANGES`
   - Entity: `MASTER_DATA_CHANGE_REQUEST`
   - Result: `SUCCESS`
   - Changes show status: `PENDING_APPROVAL` → `REJECTED`

### 4.6 Verify Unauthorised Edit Rejection

**Steps:**
1. Sign in as **Auditor** (read-only role)
2. Attempt to call `POST /api/v1/master-data/changes` directly (via API client)
3. Verify response: `403 Forbidden` / `ACCESS_DENIED`
4. Check audit log:
   - Entry exists for the denied attempt
   - Action: `ACCESS_DENIED`
   - Result: `DENIED`

---

## 5. Reason Codes Verification

### 5.1 Verify Seeded Reason Codes

**Steps:**
1. Navigate to **Master Data → Reason Codes**
2. Verify seeded reason codes exist in these categories:
   - **REVENUE**: GRANT-UNRESTRICTED, GRANT-RESTRICTED, CONTRACT-REVENUE, DONATION, INTEREST-INCOME, OTHER-INCOME
   - **EXPENSE**: PERSONNEL, TRAVEL, EQUIPMENT, CONSULTANCY, WORKSHOP, OFFICE-RENT, COMMUNICATION, VEHICLE, BANK-CHARGES, OTHER-EXPENSE
   - **TRANSFER**: INTER-PROJECT, CORE-FUNDING, RETURN-FUNDS
   - **ADJUSTMENT**: FX-GAIN, FX-LOSS, REVALUATION, WRITE-OFF, PRIOR-YEAR
   - **OTHER**: OPENING-BAL, CLOSING-BAL
3. Verify each has: code, name, description, category, isActive = true

### 5.2 Test Reason Code CRUD

**Steps:**
1. Click **Add reason code** and create:
   - Code: `TEST-RC`
   - Name: `Test Reason Code`
   - Category: `EXPENSE`
   - Description: `For testing`
2. Submit and verify in list
3. Edit the code, change name
4. Verify audit entry created
5. Deactivate (toggle isActive)
6. Verify it shows as Inactive

---

## 6. Products & Services Verification

### 6.1 Verify Seeded Products/Services

**Steps:**
1. Navigate to **Master Data → Products/Services**
2. Verify seeded entries exist:
   - `CONSULT-DAY` — Consultancy Services (Daily) — SERVICE — DAY — $500 — USD
   - `CONSULT-HOUR` — Consultancy Services (Hourly) — SERVICE — HOUR — $75 — USD
   - `TRAINING-DAY` — Training Delivery (Daily) — SERVICE — DAY — $800 — USD
   - `RESEARCH-HOUR` — Research Services (Hourly) — SERVICE — HOUR — $100 — USD
   - `REPORT` — Report Preparation — PRODUCT — UNIT — $2,000 — USD
   - `SOFTWARE-LIC` — Software License — PRODUCT — YEAR — $5,000 — USD
   - `PUBLICATION` — Research Publication — PRODUCT — UNIT — $1,500 — USD

### 6.2 Test Product/Service CRUD

**Steps:**
1. Click **Add product/service** and create:
   - Code: `TEST-SVC`
   - Name: `Test Service`
   - Type: `SERVICE`
   - Unit: `HOUR`
   - Unit Price: `150.00`
   - Currency: `USD`
2. Submit and verify in list
3. Edit and verify audit entry
4. Verify currency link works (shows USD symbol)

---

## 7. Full Integration Test Suite

Run the complete integration test suite to verify all M2 functionality:

```bash
npm run test:integration
```

**Expected Results:**
- All 7 test suites pass
- 100+ tests pass
- No failures

Key test files to verify:
- `master-data.test.ts` — 22 tests (locations, departments, cost centres, projects, funding sources)
- `master-data.approval.test.ts` — 13 tests (change requests, approval, rejection, versioning, effective dating)
- `fx-conversion.test.ts` — 14 tests (currency conversion, idempotent rates)
- `project-funding-source.test.ts` — 4 tests (project/funding source linkage)
- `rbac-negative.test.ts` — 18 tests (permission matrix, authorization failures)
- `audit-trail.test.ts` — 17 tests (append-only, chain linkage)

---

## 8. TypeScript & Lint Verification

```bash
npx tsc --noEmit
npm run lint
```

**Expected:**
- TypeScript: No errors (warnings acceptable)
- ESLint: No errors (warnings acceptable for unused vars in existing code)

---

## 9. Sign-off Checklist

| Component | Verified | Notes |
|-----------|----------|-------|
| Organisation root (BLECA, NOT_REGISTERED, TZS) | ☐ | |
| Locations CRUD + hierarchy | ☐ | |
| Departments CRUD + hierarchy | ☐ | |
| Cost Centres CRUD + dept link | ☐ | |
| Projects (IVENTIKA, UZANITE active) | ☐ | |
| Funding Sources (unrestricted + restricted) | ☐ | |
| Restricted funding scope enforcement | ☐ | |
| Currencies (TZS, USD, EUR, GBP) | ☐ | |
| Exchange rates entry + FX diff treatment | ☐ | |
| FX conversion reproducible | ☐ | |
| Change requests (create → approve) | ☐ | |
| Version snapshots on approve | ☐ | |
| Effective dating (effectiveFrom/effectiveTo) | ☐ | |
| Rejection → no version + audit | ☐ | |
| Unauthorised edit → 403 + audit | ☐ | |
| Reason codes seeded + CRUD | ☐ | |
| Products/services seeded + CRUD | ☐ | |
| Integration tests all pass | ☐ | |
| TypeScript clean | ☐ | |
| Lint clean | ☐ | |

---

## Troubleshooting

### Change request not appearing in History
- Check `master_data_change_requests` table directly
- Verify organizationId matches current user's org
- Check RLS policies if using row-level security

### FX conversion not working
- Verify exchange rate exists for the transaction date
- Check `differenceTreatment` is set (EXPENSE/INCOME/SUSPENSE)
- Ensure base currency is TZS

### Approval not working for CEO
- Verify CEO has `MASTER_DATA:APPROVE` permission
- Check `isFinalApprover` = true on CEO role
- Verify MFA is satisfied (step-up auth)

### Audit entries missing
- Check `audit_logs` table for recent entries
- Verify `writeAuditEntry` is called in API routes
- Check database triggers for append-only enforcement

---

*Document version: 1.0*  
*Generated as part of M2 Task 5 completion*