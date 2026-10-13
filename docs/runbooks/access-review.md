# Access Review Runbook

## Overview
This runbook covers the procedures for conducting periodic access reviews in BLECA SmartLabs Finance.

## Policy (PDF §4, §5)

**Frequency:** Quarterly (minimum)
**Scope:** All active users with financial permissions
**Reviewer:** CEO or designated delegate
**Evidence:** Documented decisions with reasons

---

## Access Review Lifecycle

### 1. Initiation (Automated + Manual)

**Automated Trigger:**
- Scheduled job runs quarterly (configurable)
- Creates `AccessReview` record with:
  - `periodStart`: Quarter start
  - `periodEnd`: Quarter end
  - `scopeJson`: All financial modules + admin roles
  - `initiatedById`: System user or CEO

**Manual Trigger (Ad-hoc):**
- Security incident
- Role change
- Audit finding
- New regulation

```bash
curl -X POST https://api.bleca.finance/api/v1/access-reviews \
  -H "Authorization: Bearer <token>" \
  -H "Idempotency-Key: access-review-$(date +%s)" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Q1 2026 Quarterly Access Review",
    "periodStart": "2026-01-01T00:00:00Z",
    "periodEnd": "2026-03-31T23:59:59Z",
    "scopeJson": { "modules": ["TRANSACTIONS", "APPROVALS", "PERIODS", "BACKUP_ADMIN"] }
  }'
```

### 2. Review Item Generation

System automatically creates `AccessReviewItem` for each:
- Active `UserRole` within scope
- Active `Delegation` within scope
- Each item shows:
  - User
  - Role
  - Current expiration (if temporary)
  - Permissions granted by role

### 3. Review Process

**Reviewer Actions per Item:**
| Decision | When to Use | Effect |
|----------|-------------|--------|
| `RETAIN` | Access still needed | No change |
| `REVOKE` | Access no longer needed | Sets `revokedAt` on UserRole/Delegation |
| `MODIFY` | Scope/level needs change | Requires new role assignment |

**Review Criteria:**
- [ ] User still employed/active
- [ ] Role matches current job function
- [ ] Permissions follow least privilege
- [ ] No SOD violations (same user can't submit + approve)
- [ ] Temporary access expired appropriately
- [ ] Delegations have valid business justification

### 4. Decision Recording

```bash
curl -X PATCH https://api.bleca.finance/api/v1/access-reviews/{reviewId}/items/{itemId} \
  -H "Authorization: Bearer <token>" \
  -H "Idempotency-Key: review-decision-$(date +%s)" \
  -H "Content-Type: application/json" \
  -d '{
    "decision": "RETAIN",
    "decisionReason": "User is Finance Officer, requires APPROVE on TRANSACTIONS"
  }'
```

**Required Fields:**
- `decision`: `RETAIN` | `REVOKE` | `MODIFY`
- `decisionReason`: Mandatory text justification

### 5. Completion

When all items decided:
1. Reviewer marks review `COMPLETED`
2. System applies revocations (sets `revokedAt`)
3. Audit log: `ACCESS_REVIEW_COMPLETED` with summary
4. Report generated for compliance

---

## API Reference

### Create Access Review
```
POST /api/v1/access-reviews
Body: { name, periodStart, periodEnd, scopeJson }
Permissions: USERS_ROLES:ADMINISTER
```

### Get Review with Items
```
GET /api/v1/access-reviews/{reviewId}
Permissions: USERS_ROLES:VIEW
```

### Update Review Item Decision
```
PATCH /api/v1/access-reviews/{reviewId}/items/{itemId}
Body: { decision, decisionReason }
Permissions: USERS_ROLES:APPROVE
```

### Complete Review
```
POST /api/v1/access-reviews/{reviewId}/complete
Permissions: USERS_ROLES:ADMINISTER
```

### List Reviews
```
GET /api/v1/access-reviews?status=OPEN|IN_REVIEW|COMPLETED
Permissions: USERS_ROLES:VIEW
```

---

## Quarterly Review Checklist

### Pre-Review (Week 1)
- [ ] Review initiated (auto or manual)
- [ ] Scope confirmed with CEO
- [ ] Reviewer assigned (CEO or delegate)
- [ ] Review items generated and visible

### During Review (Weeks 2-3)
- [ ] Reviewer accesses `/admin/access-reviews/{id}`
- [ ] Each item reviewed with decision + reason
- [ ] SOD violations flagged and resolved
- [ ] Temporary access expirations verified
- [ ] Delegation justifications reviewed

### Post-Review (Week 4)
- [ ] All items have decisions
- [ ] Review marked COMPLETED
- [ ] Revocations applied automatically
- [ ] Audit log reviewed for completeness
- [ ] Compliance report generated

---

## SOD Violation Detection

During review, automatically flag:
1. **Submit + Approve**: Same user has both `TRANSACTIONS:SUBMIT` and `TRANSACTIONS:APPROVE`
2. **Approve + Post**: Same user has both `TRANSACTIONS:APPROVE` and `TRANSACTIONS:POST`
3. **Backup + Audit**: Same user has `BACKUP_ADMIN` and `AUDIT_TRAIL:VIEW`
4. **User Admin + Permission Admin**: Same user has `USERS_ROLES:ADMINISTER` and `API_ADMIN`

**Resolution:**
- `REVOKE` one conflicting role
- Or document `SOD_WAIVER` with CEO approval (rare, time-limited)

---

## Temporary Access Review

**Special attention to:**
- `UserRole.isTemporary = true`
- `UserRole.expiresAt` in the past (should be auto-revoked)
- `Delegation` with `expiresAt` in the past

**Action:**
- If expired but not revoked → `REVOKE` with reason "Auto-expired"
- If still needed → `MODIFY` to extend with new justification

---

## Delegation Review

**Check each active delegation:**
- [ ] Grantor still in role
- [ ] Grantee still employed
- [ ] Scope appropriate (not overly broad)
- [ ] Expiration date set and reasonable
- [ ] Business justification documented

---

## Reporting

### Review Summary Report
Generated on completion:
- Total items reviewed
- Decisions breakdown (RETAIN/REVOKE/MODIFY)
- SOD violations found/resolved
- Temporary access cleaned up
- Delegations reviewed
- Open findings requiring follow-up

### Compliance Report
For auditors:
- Review period
- Reviewer identity
- Methodology
- Results summary
- Exceptions with compensating controls

---

## Automation

**Nightly Jobs:**
1. Expire temporary roles/delegations past `expiresAt`
2. Flag users with no active role but active sessions
3. Detect SOD violations in real-time

**Quarterly Job:**
1. Create access review record
2. Generate review items
3. Notify reviewer
4. Escalate if not started in 7 days

---

## Emergency Access Review

**Trigger:** Security incident, auditor request, key personnel departure
**Process:**
1. Create ad-hoc review with narrow scope
2. 48-hour completion target
3. CEO direct oversight
4. Findings fed into incident response

---

## Revision History

| Date | Version | Author | Changes |
|------|---------|--------|---------|
| 2026-10-13 | 1.0 | System | Initial version for M17 |