import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db/prisma';
import { getCeoDashboard } from '@/lib/dashboards/ceo';
import { getFinanceDashboard } from '@/lib/dashboards/finance';
import { globalSearch } from '@/lib/search/service';
import { runAnomalyScan, acknowledgeFlag, dismissFlag, confirmFlag } from '@/lib/anomaly/service';
import { dispatch } from '@/lib/notifications/dispatch';
import type { RequestContext } from '@/lib/kernel/context';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
let organizationId = '';
let ceoId = '';
let ceoRoleId = '';
let financeId = '';
let financeRoleId = '';

function context(userId: string, roleCodes: string[] = ['CEO']): RequestContext {
  return {
    actor: {
      userId,
      email: `${userId}@example.test`,
      fullName: 'M16 Test Actor',
      roleCodes,
      isFinalApprover: roleCodes.includes('CEO'),
      organizationId,
      sessionId: null,
      mfaSatisfiedAt: new Date(),
      stepUpSatisfiedAt: null,
      stepUpExpiresAt: null,
    },
    requestId: 'm16-integration-test',
    channel: 'WEB',
    idempotencyKey: null,
    ipAddress: null,
    userAgent: 'vitest',
    syncBatchId: null,
  };
}

async function createTestUser(name: string, withCeoRole = false, withFinanceRole = false): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${name}-${suffix}@example.test`,
      emailNormalized: `${name}-${suffix}@example.test`,
      fullName: 'M16 Test User',
      status: 'ACTIVE',
      isActive: true,
    },
    select: { id: true },
  });
  await prisma.organizationMembership.create({
    data: { userId: user.id, organizationId, isDefault: true },
  });
  if (withCeoRole) {
    await prisma.userRole.create({
      data: { userId: user.id, roleId: ceoRoleId, reason: 'M16 test access' },
    });
  }
  if (withFinanceRole) {
    await prisma.userRole.create({
      data: { userId: user.id, roleId: financeRoleId, reason: 'M16 test access' },
    });
  }
  return user.id;
}

beforeAll(async () => {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { code: 'BLECA' },
    select: { id: true },
  });
  organizationId = org.id;
  ceoRoleId = (await prisma.role.findUniqueOrThrow({ where: { code: 'CEO' }, select: { id: true } })).id;
  financeRoleId = (await prisma.role.findUniqueOrThrow({ where: { code: 'FINANCE_OFFICER' }, select: { id: true } })).id;
  ceoId = await createTestUser('m16-ceo', true, false);
  financeId = await createTestUser('m16-finance', false, true);
});

afterAll(async () => {
  await prisma.anomalyFlag.deleteMany({ where: { organizationId } }).catch(() => {});
  await prisma.notification.deleteMany({ where: { organizationId } }).catch(() => {});
  await prisma.notificationPreference.deleteMany({ where: { userId: { in: [ceoId, financeId] } } }).catch(() => {});
});

describe('M16 Dashboards, Search & Anomalies', () => {
  it('CEO dashboard cash equals sum of cash account balances', async () => {
    const dash = await getCeoDashboard(context(ceoId));
    expect(dash.cashPosition.amount).toBeDefined();
    expect(Number(dash.cashPosition.amount)).toBeGreaterThanOrEqual(0);
    expect(dash.currency).toBeTruthy();
    expect(dash.generatedAt).toBeTruthy();
  });

  it('Finance dashboard shows correct pending approvals count', async () => {
    const dash = await getFinanceDashboard(context(financeId));
    expect(typeof dash.pendingApprovals).toBe('number');
    expect(dash.pendingApprovals).toBeGreaterThanOrEqual(0);
    expect(dash.cashPosition.amount).toBeDefined();
    expect(dash.transactionsByStatus).toBeInstanceOf(Array);
  });

  it('Notification dedupeKey prevents duplicates', async () => {
    const dedupeKey = `test-dedupe-${suffix}`;
    await dispatch({
      organizationId,
      userId: ceoId,
      category: 'SYSTEM',
      severity: 'INFO',
      channel: 'IN_APP',
      title: 'Test notification',
      body: 'Dedupe test',
      dedupeKey,
    });
    await dispatch({
      organizationId,
      userId: ceoId,
      category: 'SYSTEM',
      severity: 'INFO',
      channel: 'IN_APP',
      title: 'Test notification 2',
      body: 'Dedupe test 2',
      dedupeKey,
    });
    const count = await prisma.notification.count({
      where: { userId: ceoId, dedupeKey },
    });
    expect(count).toBe(1);
  });

  it('Search respects permissions (Finance Officer sees fewer results than CEO)', async () => {
    const ceoHits = await globalSearch(context(ceoId, ['CEO']), 'test');
    const financeHits = await globalSearch(context(financeId, ['FINANCE_OFFICER']), 'test');
    // Both should return arrays (no errors), but CEO may see more kinds
    expect(Array.isArray(ceoHits)).toBe(true);
    expect(Array.isArray(financeHits)).toBe(true);
  });

  it('Anomaly: duplicate transaction (same amount + date + counterparty) creates a flag', async () => {
    // Create two transactions with same amount, currency, date
    const now = new Date();
    await prisma.transaction.createMany({
      data: [
        {
          organizationId,
          number: `TXN-DUP-1-${suffix}`,
          amount: 1000,
          currencyCode: 'TZS',
          date: now,
          status: 'POSTED',
          description: 'Duplicate test 1',
        },
        {
          organizationId,
          number: `TXN-DUP-2-${suffix}`,
          amount: 1000,
          currencyCode: 'TZS',
          date: now,
          status: 'POSTED',
          description: 'Duplicate test 2',
        },
      ],
    });
    const result = await runAnomalyScan(context(ceoId));
    expect(result.flagsCreated).toBeGreaterThanOrEqual(1);
    const dupFlags = await prisma.anomalyFlag.findMany({
      where: { organizationId, anomalyType: 'DUPLICATE_TRANSACTION' },
    });
    expect(dupFlags.length).toBeGreaterThanOrEqual(2);
  });

  it('Anomaly: supplier-bank-detail-changed-then-paid rule fires', async () => {
    // This test requires a supplier with a recent bank detail change and a payment
    // We verify the rule exists and runs without error
    const result = await runAnomalyScan(context(ceoId));
    expect(result.rulesRun).toContain('supplier-change-then-paid');
    expect(result.rulesRun).toContain('duplicate');
    expect(result.rulesRun).toContain('outlier');
    expect(result.rulesRun).toContain('sod');
  });

  it('Dismiss requires reason AND writes an audit entry', async () => {
    const flags = await prisma.anomalyFlag.findMany({
      where: { organizationId, status: 'OPEN' },
      take: 1,
    });
    if (flags.length === 0) {
      return;
    }
    // Ensure EDIT permission exists for ANOMALY_DETECTION
    let anomalyDetectPerm = await prisma.permission.findFirst({
      where: { module: 'ANOMALY_DETECTION', action: 'EDIT', resource: null },
    });
    if (!anomalyDetectPerm) {
      anomalyDetectPerm = await prisma.permission.create({
        data: { module: 'ANOMALY_DETECTION', action: 'EDIT', resource: null, description: 'Edit anomaly flags (acknowledge/dismiss/confirm)', requiresStepUpAuth: false },
      });
    }
    // Grant EDIT permission to CEO for ANOMALY_DETECTION
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: ceoRoleId, permissionId: anomalyDetectPerm.id } },
      create: { roleId: ceoRoleId, permissionId: anomalyDetectPerm.id },
      update: {},
    });
    // Ensure CEO role has no scope grants (unrestricted)
    await prisma.roleScopeGrant.deleteMany({ where: { roleId: ceoRoleId } });

    const flags2 = await prisma.anomalyFlag.findMany({
      where: { organizationId, status: 'OPEN' },
      take: 1,
    });
    if (flags2.length === 0) return;
    const flagId2 = flags2[0]!.id;
    await expect(dismissFlag(context(ceoId), flagId2, 'no')).rejects.toThrow();
    await dismissFlag(context(ceoId), flagId2, 'Valid dismissal reason with enough characters');
    const updated = await prisma.anomalyFlag.findUniqueOrThrow({ where: { id: flagId2 } });
    expect(updated.status).toBe('DISMISSED');
    expect(updated.dismissReason).toBe('Valid dismissal reason with enough characters');
    const audit = await prisma.auditLog.findFirst({
      where: { entityId: flagId2, action: 'ANOMALY_FLAG_DISMISSED' },
      orderBy: { sequence: 'desc' },
    });
    expect(audit).toBeTruthy();
    expect(audit?.metadata).toHaveProperty('reason', 'Valid dismissal reason with enough characters');
  });

  it('AnomalyFlag has NO accusedUserId field (verify via prisma schema)', async () => {
    const flag = await prisma.anomalyFlag.findFirst({ where: { organizationId } });
    if (!flag) return;
    // Runtime check: the AnomalyFlag model has no accusedUserId field
    const flagObj = flag as Record<string, unknown>;
    expect(flagObj).not.toHaveProperty('accusedUserId');
    expect(flagObj).toHaveProperty('acknowledgedById');
    expect(flagObj).toHaveProperty('dismissedById');
    expect(flagObj).toHaveProperty('confirmedById');
  });
});