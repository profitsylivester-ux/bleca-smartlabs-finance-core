# Period Reopen Runbook

## Overview
This runbook covers the procedures for reopening a closed financial period in BLECA SmartLabs Finance.

## Policy (PDF §63)

**Reopening a closed period is a highly controlled action requiring:**
1. CEO approval (SIGN_OFF step)
2. Documented business justification
3. Audit trail of all changes made during reopen window
4. Subsequent period close with full checklist

**Maximum reopen count:** 2 per period (configurable via AuthPolicy)

---

## When Period Reopen is Allowed

| Reason | Allowed | Notes |
|--------|---------|-------|
| Missed adjusting entry | Yes | Must be documented |
| Correction of material error | Yes | Requires auditor sign-off |
| Late-arriving invoice | Yes | With evidence of date |
| Tax filing correction | Yes | With tax authority notice |
| "Forgot to post" | No | Process failure, not data error |
| Convenience | No | Never allowed |

---

## Reopen Procedure

### Phase 1: Request & Approval

#### 1. Submit Reopen Request
**Via API:**
```bash
curl -X POST https://api.bleca.finance/api/v1/periods/{periodId}/reopen \
  -H "Authorization: Bearer <token>" \
  -H "Idempotency-Key: reopen-$(date +%s)" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Missed accrual for December utilities - invoice received Jan 5",
    "evidenceDocumentId": "doc_abc123"
  }'
```

**Required Permissions:**
- Module: `PERIODS`
- Action: `CREATE` (to submit request)

#### 2. Approval Workflow
The request triggers an approval workflow with:
1. **Finance Officer Review** (REVIEW step)
2. **CEO Sign-Off** (SIGN_OFF step - mandatory per PDF §3.1)

**Approval Criteria:**
- [ ] Valid business reason documented
- [ ] Supporting evidence attached
- [ ] Impact assessment completed (which accounts, estimated amounts)
- [ ] No more than 2 previous reopens for this period

### Phase 2: Execution

#### 3. Period Status Changes
Upon CEO approval:
1. Period status: `CLOSED` → `REOPEN_PENDING` → `REOPENED`
2. `reopenCount` incremented
3. `FinancialClose` record created with status `REOPENED`
4. Audit log: `PERIOD_REOPENED` action

#### 4. Reopen Window
- Default: 5 business days
- Configurable via AuthPolicy
- Only adjusting entries allowed during window
- All entries tagged with `JournalEntryType: ADJUSTMENT`

### Phase 3: Work During Reopen

#### Allowed Actions:
- Create adjusting journal entries
- Post adjusting entries (with approval)
- Reverse entries created in error during original close

#### Blocked Actions:
- New standard transactions (use current period)
- Period close (must complete reopen window first)
- Budget changes for reopened period

#### Monitoring:
- All activity during reopen logged with `metadata.reopenContext: true`
- Daily summary emailed to Finance Officer + CEO

### Phase 4: Re-Close

#### 5. Complete Reopen Work
When all adjustments posted:
```bash
curl -X POST https://api.bleca.finance/api/v1/financial-close/{closeId}/submit \
  -H "Authorization: Bearer <token>" \
  -H "Idempotency-Key: reclose-$(date +%s)"
```

#### 6. Re-Close Checklist
Full financial close checklist must be re-run:
- [ ] Bank reconciliation
- [ ] Cash reconciliation
- [ ] Receivables review
- [ ] Payables review
- [ ] Missing documents
- [ ] Unapproved transactions
- [ ] Budget variances
- [ ] Adjustments review
- [ ] Financial statements
- [ ] Open items disclosed

#### 7. CEO Sign-Off (Again)
Second SIGN_OFF required for re-close.

#### 8. Final Status
Period status: `REOPENED` → `CLOSED` → `LOCKED`
Audit log: `PERIOD_LOCKED` with `metadata.reopenCount`

---

## API Reference

### Submit Reopen Request
```
POST /api/v1/periods/{periodId}/reopen
Body: { reason: string, evidenceDocumentId?: string }
Permissions: PERIODS:CREATE
```

### Get Reopen Status
```
GET /api/v1/periods/{periodId}/reopen-status
Permissions: PERIODS:VIEW
```

### List Period Reopens
```
GET /api/v1/periods/reopens?status=PENDING|APPROVED|COMPLETED
Permissions: PERIODS:VIEW
```

---

## Audit Requirements

Every period reopen generates these audit entries:
1. `PERIOD_REOPEN_REQUESTED` - request submitted
2. `APPROVAL_REQUEST_CREATED` - workflow started
3. `APPROVAL_STEP_DECIDED` - Finance Officer review
4. `APPROVAL_STEP_DECIDED` - CEO sign-off
5. `PERIOD_REOPENED` - period status changed
6. `JOURNAL_ENTRY_CREATED/POSTED` - each adjustment (with `reopenContext`)
7. `PERIOD_REOPEN_APPROVED` - re-close submitted
8. `FINANCIAL_CLOSE_SIGNED_OFF` - CEO re-close sign-off
9. `PERIOD_LOCKED` - period locked again

---

## Evidence Requirements

**Minimum evidence for each reopen reason:**

| Reason | Required Evidence |
|--------|-------------------|
| Missed adjusting entry | Invoice/contract showing service period |
| Correction of error | Analysis showing error + correction calculation |
| Late invoice | Invoice with service date in closed period |
| Tax correction | Official notice from tax authority |

Evidence must be uploaded as Document (category: `FINANCIAL_EVIDENCE`) before request.

---

## Limits & Controls

| Control | Value | Configurable |
|---------|-------|--------------|
| Max reopens per period | 2 | Yes (AuthPolicy) |
| Reopen window duration | 5 business days | Yes (AuthPolicy) |
| CEO sign-off required | Always | No (hardcoded) |
| Finance Officer review | Always | No (hardcoded) |
| Adjusting entries only | Enforced by API | No (hardcoded) |

---

## Emergency Reopen

**Only for:** Regulatory filing deadline with penalty
**Process:**
1. CEO verbal approval + written confirmation within 1 hour
2. Emergency reopen window: 24 hours
3. Full retrospective approval within 48 hours
4. Board notification within 7 days

---

## Revision History

| Date | Version | Author | Changes |
|------|---------|--------|---------|
| 2026-10-13 | 1.0 | System | Initial version for M17 |