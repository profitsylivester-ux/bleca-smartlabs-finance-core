# Rollback Runbook

## Overview
This runbook covers the procedures for rolling back a bad deployment in BLECA SmartLabs Finance.

## When to Rollback

**Automatic Triggers:**
- Health check fails (`/api/v1/health` returns unhealthy)
- Error rate > 5% for 5 minutes
- Critical user-facing feature broken (login, transaction posting, approvals)
- Database migration failed

**Manual Triggers:**
- CEO/CTO decision
- Major bug reported by users
- Performance degradation > 50%

---

## Rollback Types

### 1. Vercel Deployment Rollback (Preferred)
Fastest method - reverts to previous deployment.

```bash
# List recent deployments
vercel ls bleca-finance

# Rollback to specific deployment
vercel rollback <deployment-url> --token=$VERCEL_TOKEN

# Or promote previous deployment
vercel promote <previous-deployment-url> --token=$VERCEL_TOKEN
```

**Time:** ~2-3 minutes
**Data Loss:** None (stateless frontend/API)

### 2. Database Migration Rollback
If migration caused issues:

```bash
# Check migration status
npx prisma migrate status

# If migration applied but broken, create a new migration to revert
npx prisma migrate dev --name rollback_bad_migration
# Edit the generated migration to drop/revert changes
npx prisma migrate deploy
```

**Time:** ~5-15 minutes
**Data Loss:** Depends on migration (see below)

### 3. Full Restore from Backup
If data corruption occurred:
- Follow Backup & Restore runbook
- **Time:** 30-60 minutes
- **Data Loss:** Since last backup

---

## Pre-Rollback Checklist

- [ ] Confirm rollback is necessary (not a transient issue)
- [ ] Identify the problematic deployment/commit
- [ ] Notify stakeholders (CEO, team) of rollback decision
- [ ] Verify previous deployment is healthy
- [ ] Check if database migration was involved

---

## Rollback Procedure

### Step 1: Assess Impact
```bash
# Check current health
curl https://api.bleca.finance/api/v1/health

# Check error rates in Vercel dashboard / logs
# Check user reports
```

### Step 2: Choose Rollback Method

| Scenario | Method |
|----------|--------|
| Frontend/API bug, no DB changes | Vercel rollback |
| Bad DB migration, no data written | Prisma migration rollback |
| Bad DB migration, data written | Backup restore |
| Infrastructure issue | Vercel rollback + infra fix |

### Step 3: Execute Rollback

#### Vercel Rollback
```bash
# 1. Identify last good deployment
vercel ls bleca-finance --token=$VERCEL_TOKEN

# 2. Rollback
vercel rollback <last-good-deployment-url> --token=$VERCEL_TOKEN

# 3. Verify
curl https://api.bleca.finance/api/v1/health
```

#### Database Migration Rollback
```bash
# 1. Check what was applied
npx prisma migrate status

# 2. If the last migration is the problem:
# Create a revert migration
npx prisma migrate dev --name revert_<bad_migration_name>

# 3. Edit the generated file to undo changes
# 4. Apply
npx prisma migrate deploy

# 5. Verify
npx prisma migrate status
curl https://api.bleca.finance/api/v1/health
```

### Step 4: Post-Rollback Verification

- [ ] Health check passes
- [ ] Critical user flows work (login, create transaction, approve, post)
- [ ] No error spikes in logs
- [ ] Audit chain verification passes (run manually if needed)
- [ ] Key reports generate (Trial Balance)

### Step 5: Communicate
- [ ] Notify team rollback complete
- [ ] Update incident record with timeline
- [ ] Schedule root cause analysis

---

## Database Migration Rollback Details

### Safe Migrations (Can Revert Easily)
- Adding nullable columns
- Adding indexes
- Creating new tables (if no data inserted)

### Risky Migrations (Require Backup Restore)
- Dropping columns/tables
- Changing column types
- Adding NOT NULL columns without defaults
- Data transformations

### If Risky Migration Applied with Data
1. **Stop application** (maintenance mode)
2. **Backup current state** (safety net)
3. **Restore from pre-migration backup**
4. **Apply fixed migration**
5. **Verify data integrity**

---

## Feature Flag Alternative

For non-critical features, consider feature flags instead of rollback:

```typescript
// lib/features/flags.ts
export const flags = {
  newReportEngine: process.env.FF_NEW_REPORT_ENGINE === 'true',
  enhancedReconciliation: process.env.FF_ENHANCED_RECON === 'true',
};
```

Set via Vercel environment variables - instant toggle, no deployment needed.

---

## Post-Rollback Actions

1. **Create incident record** with:
   - Deployment URL/commit that caused issue
   - Rollback method used
   - Time to detect, decide, execute
   - User impact

2. **Root Cause Analysis** within 24 hours:
   - Why wasn't it caught in CI/staging?
   - What test/validation would have prevented it?
   - Process improvement

3. **Fix & Re-deploy**:
   - Fix the underlying issue
   - Add regression test
   - Deploy with extra monitoring

---

## Emergency Contacts

| Role | Name | Contact |
|------|------|---------|
| CEO (Approval) | [Name] | [Phone/Email] |
| On-call Engineer | [Name] | [Phone/Email] |
| Database Admin | [Name] | [Phone/Email] |
| Vercel Admin | [Name] | [Phone/Email] |

---

## Revision History

| Date | Version | Author | Changes |
|------|---------|--------|---------|
| 2026-10-13 | 1.0 | System | Initial version for M17 |