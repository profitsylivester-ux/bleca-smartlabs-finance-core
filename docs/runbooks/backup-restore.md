# Backup & Restore Runbook

## Overview
This runbook covers the procedures for running, verifying, and testing restores of BLECA SmartLabs Finance backups.

## Backup Types

### FULL Backup
- Complete export of all organization data as JSON
- Includes all tables, audit chain head, and row counts
- Stored in configured storage provider (local filesystem or S3)
- Checksummed with SHA-256 for integrity verification

### INCREMENTAL Backup
- Export of data changed since last successful backup
- Uses audit log sequence numbers to determine delta
- Smaller and faster than FULL backups

### POINT_IN_TIME Backup
- Snapshot at a specific moment (e.g., before major deployment)
- Created manually via API or scheduled

---

## Running a Backup

### Via API (Recommended)
```bash
# Full backup
curl -X POST https://api.bleca.finance/api/v1/backups/run \
  -H "Authorization: Bearer <token>" \
  -H "Idempotency-Key: backup-full-$(date +%s)" \
  -H "Content-Type: application/json" \
  -d '{"type": "FULL"}'

# Incremental backup
curl -X POST https://api.bleca.finance/api/v1/backups/run \
  -H "Authorization: Bearer <token>" \
  -H "Idempotency-Key: backup-inc-$(date +%s)" \
  -H "Content-Type: application/json" \
  -d '{"type": "INCREMENTAL"}'
```

### Required Permissions
- Module: `BACKUP_ADMIN`
- Action: `CREATE`

---

## Verifying a Backup

Verification re-reads the backup from storage, recomputes the checksum, and compares it to the stored value.

### Via API
```bash
curl -X POST https://api.bleca.finance/api/v1/backups/{backupId}/verify \
  -H "Authorization: Bearer <token>" \
  -H "Idempotency-Key: verify-$(date +%s)"
```

### Required Permissions
- Module: `BACKUP_ADMIN`
- Action: `APPROVE`

---

## Testing a Restore (Non-Destructive)

**IMPORTANT**: `testRestore` does NOT overwrite production data. It only compares:
1. Row counts per table between backup and current database
2. Audit chain head hash between backup and current database

### Via API
```bash
curl -X POST https://api.bleca.finance/api/v1/backups/{backupId}/restore-test \
  -H "Authorization: Bearer <token>" \
  -H "Idempotency-Key: restore-test-$(date +%s)"
```

### Required Permissions
- Module: `BACKUP_ADMIN`
- Action: `APPROVE`

### Interpreting Results
| Field | Meaning |
|-------|---------|
| `tableCountsMatch: true` | All tables have identical row counts |
| `auditChainMatches: true` | Audit chain head is identical (no tampering) |
| `tableCountDiffs` | Lists tables with count differences |
| `auditChainHeadMatch: false` | **CRITICAL** - audit chain diverged |

---

## Performing an Actual Restore (Disaster Recovery)

**WARNING**: This overwrites production data. Requires CEO approval and maintenance window.

### Prerequisites
- [ ] CEO written approval obtained
- [ ] Maintenance window scheduled and communicated
- [ ] Current database backed up first (safety net)
- [ ] Verified backup selected

### Procedure
1. Put application in maintenance mode
2. Stop all background workers
3. Restore from backup using storage provider tools
4. Verify critical data
5. Take application out of maintenance mode
6. Restart background workers
7. Post-restore verification
8. Record incident in incident tracker

---

## Backup Retention Policy

| Backup Type | Retention | Notes |
|-------------|-----------|-------|
| FULL | 1 year | Monthly FULL kept for 7 years |
| INCREMENTAL | 30 days | Superseded by next FULL |
| POINT_IN_TIME | 90 days | Manual cleanup after major events |

---

## Monitoring & Alerts

### Daily Checks (Automated)
- Last FULL backup completed successfully (< 25 hours ago)
- Last backup verification passed
- Storage usage < 80% capacity

### Alert Conditions
| Condition | Severity | Action |
|-----------|----------|--------|
| No successful backup in 26 hours | CRITICAL | Page on-call |
| Backup verification failed | HIGH | Investigate within 1 hour |
| Storage > 85% full | MEDIUM | Plan capacity increase |
| Audit chain verification failed | CRITICAL | Page on-call + CEO |

---

## Emergency Contacts

| Role | Name | Contact |
|------|------|---------|
| CEO (Final Approver) | [CEO Name] | [Phone/Email] |
| Finance Officer | [Name] | [Phone/Email] |
| Lead Engineer | [Name] | [Phone/Email] |
| Infrastructure | [Name] | [Phone/Email] |

---

## Revision History

| Date | Version | Author | Changes |
|------|---------|--------|---------|
| 2026-10-13 | 1.0 | System | Initial version for M17 |