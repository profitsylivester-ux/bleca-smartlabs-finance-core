# Security Incident Response Runbook

## Overview
This runbook defines the procedures for responding to security incidents in BLECA SmartLabs Finance.

## Incident Classification

| Severity | Definition | Response Time | Escalation |
|----------|------------|---------------|------------|
| CRITICAL | Active breach, data exfiltration, audit chain broken | Immediate (15 min) | CEO + CTO + Legal |
| HIGH | Compromised credentials, privilege escalation, unauthorized access | 1 hour | CTO + Security Lead |
| MEDIUM | Suspicious activity, failed brute force, anomalous patterns | 4 hours | Security Lead |
| LOW | Policy violation, minor misconfiguration | 24 hours | Team Lead |

---

## Incident Response Phases

### 1. Detection & Reporting
**Sources:**
- Automated alerts (audit chain verification, rate limiting, anomaly detection)
- User reports
- Security event dashboard (`/admin/security-events`)
- External notifications

**Initial Actions:**
1. Acknowledge alert in security events dashboard
2. Assign incident commander (senior engineer on-call)
3. Create incident record with:
   - Timestamp of detection
   - Source of detection
   - Initial severity assessment
   - Affected systems/data

### 2. Containment
**Immediate (0-15 min):**
- [ ] Isolate affected systems if active breach
- [ ] Revoke compromised sessions/API keys
- [ ] Enable enhanced logging
- [ ] Preserve evidence (don't delete logs!)

**Short-term (15 min - 1 hour):**
- [ ] Reset compromised credentials
- [ ] Apply emergency patches if vulnerability exploited
- [ ] Block malicious IPs at WAF/firewall
- [ ] Notify CEO if CRITICAL/HIGH

### 3. Investigation
**Evidence Collection:**
- Audit log entries (tamper-evident chain)
- Security events with full detail
- Access logs (application + infrastructure)
- Database query logs
- Network flow logs

**Analysis:**
- Determine attack vector
- Identify scope of compromise
- Check for data exfiltration
- Verify audit chain integrity
- Check for persistence mechanisms

### 4. Eradication
- Remove malware/backdoors
- Close exploited vulnerabilities
- Rotate ALL credentials potentially exposed
- Rebuild compromised systems from known-good state
- Update detection rules

### 5. Recovery
- Restore from verified backup if needed (follow Backup & Restore runbook)
- Verify audit chain integrity post-recovery
- Gradual service restoration with enhanced monitoring
- User communication if data was affected

### 6. Post-Incident
**Within 24 hours:**
- [ ] Incident timeline documented
- [ ] Root cause analysis completed
- [ ] Action items assigned with owners/dates

**Within 7 days:**
- [ ] Post-mortem review meeting
- [ ] Process improvements implemented
- [ ] Detection rules updated
- [ ] Runbook updated if needed

---

## Specific Incident Types

### Audit Chain Verification Failed
**Immediate Actions:**
1. Treat as CRITICAL - potential data tampering
2. Freeze all financial mutations (period close, posting, approvals)
3. Verify backup integrity (run restore-test on latest backup)
4. Compare audit chain heads between backup and production
5. If chains diverge: identify divergence point via checkpoints

**Investigation:**
- Check `AuditChainCheckpoint` table for `BROKEN` status
- Review `SecurityEvent` with type `AUDIT_CHAIN_BROKEN`
- Check for unauthorized database access
- Review admin activity in audit log

### Compromised Admin Credentials
**Immediate Actions:**
1. Revoke all sessions for affected user
2. Force password reset + MFA re-enrollment
3. Review all actions by user in last 48 hours
4. Check for privilege escalation attempts
5. Audit role/permission changes made by user

### Brute Force / Credential Stuffing
**Detection:** `SecurityEvent` type `BRUTE_FORCE_ATTEMPT` or `CREDENTIAL_STUFFING_PATTERN`
**Actions:**
1. Verify rate limiting is active
2. Check if any accounts were actually compromised
3. Force password reset for targeted accounts
4. Review IP reputation, consider geo-blocking
5. Update auth policy if needed (stricter lockout)

### Suspicious Export Volume
**Detection:** `SecurityEvent` type `SUSPICIOUS_EXPORT_VOLUME`
**Actions:**
1. Identify user and exported data
2. Verify business justification
3. Check if data includes PII/financial records
4. If unauthorized: treat as data exfiltration (CRITICAL)

### Supplier Bank Detail Changed Then Paid
**Detection:** `SecurityEvent` type `SUPPLIER_DETAIL_CHANGED_THEN_PAID` (PDF §23 fraud pattern)
**Actions:**
1. Immediately halt payment to affected supplier
2. Verify bank detail change approval trail
3. Contact supplier via known-good channel
4. If fraudulent: initiate recovery procedures

---

## Communication Plan

### Internal
| Audience | Channel | Timing |
|----------|---------|--------|
| On-call engineer | PagerDuty/Phone | Immediate |
| Security team | Slack #security-incidents | Within 15 min |
| CEO | Phone + Email | CRITICAL: Immediate, HIGH: 30 min |
| All engineering | Slack #engineering | Within 1 hour (if user-facing) |

### External
| Audience | When | Template |
|----------|------|----------|
| Customers | If their data affected | Legal-approved notification |
| Regulators | If required by law | Within 72 hours (GDPR-style) |
| Partners | If integration affected | Case by case |

---

## Evidence Preservation

**DO NOT:**
- Delete any logs or database records
- Restart affected servers before forensic capture
- Modify audit log or security event tables

**DO:**
- Export relevant audit log ranges
- Capture database snapshots
- Save security event details with full JSON
- Document all actions taken with timestamps

---

## Tools & Access

| Tool | Purpose | Access |
|------|---------|--------|
| `/admin/security-events` | View/acknowledge/resolve events | Security team, CEO |
| `GET /api/v1/health` | System health check | All engineers |
| `POST /api/v1/backups/{id}/restore-test` | Verify backup integrity | Backup admin |
| Prisma Studio / psql | Direct DB inspection | Senior engineers only |
| Vercel logs | Application logs | All engineers |
| CloudWatch / provider logs | Infrastructure logs | Infra team |

---

## Emergency Contacts

| Role | Name | Phone | Email | Backup |
|------|------|-------|-------|--------|
| Incident Commander (Primary) | [Name] | [Phone] | [Email] | [Backup Name] |
| CEO | [Name] | [Phone] | [Email] | - |
| Legal Counsel | [Name] | [Phone] | [Email] | - |
| Infrastructure Lead | [Name] | [Phone] | [Email] | [Backup Name] |
| Database Admin | [Name] | [Phone] | [Email] | [Backup Name] |

---

## Regulatory Requirements

**Tanzania Data Protection:**
- Notify affected individuals "without undue delay" if personal data breached
- Report to regulator within 72 hours if risk to rights/freedoms
- Maintain incident register

**Financial Records:**
- Preserve all financial data integrity
- Document any period where ledger integrity was questionable
- Auditor notification if financial statements affected

---

## Revision History

| Date | Version | Author | Changes |
|------|---------|--------|---------|
| 2026-10-13 | 1.0 | System | Initial version for M17 |