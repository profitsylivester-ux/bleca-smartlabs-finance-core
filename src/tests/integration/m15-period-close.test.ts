import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db/prisma';
import type { RequestContext } from '@/lib/kernel/context';
import {
  startClose,
  getCloseState,
  waiveChecklistItem,
  confirmChecklistItem,
  submitCloseForSignOff,
  signOffClose,
  generateCloseReport,
} from '@/lib/close/service';
import { advanceRequest } from '@/lib/approvals/engine';
import { runAllAutomatedChecks } from '@/lib/close/checks';
import { runYearEndProcedure, createAdjustmentPeriod } from '@/lib/close/year-end';
import type { AutomatedCheckResult } from '@/lib/close/checks';
import type { YearEndResult } from '@/lib/close/year-end';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
let organizationId = '';
let ceoId = '';
let ceoRoleId = '';

function context(userId: string, roleCodes: string[] = ['CEO']): RequestContext {
  return {
    actor: {
      userId,
      email: `${userId}@example.test`,
      fullName: 'M15 Test Actor',
      roleCodes,
      isFinalApprover: roleCodes.includes('CEO'),
      organizationId,
      sessionId: null,
      mfaSatisfiedAt: new Date(),
      stepUpSatisfiedAt: null,
      stepUpExpiresAt: null,
    },
    requestId: 'm15-integration-test',
    channel: 'WEB',
    idempotencyKey: null,
    ipAddress: null,
    userAgent: 'vitest',
    syncBatchId: null,
  };
}

async function createTestUser(name: string, withCeoRole = false): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${name}-${suffix}@example.test`,
      emailNormalized: `${name}-${suffix}@example.test`,
      fullName: 'M15 Test User',
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
      data: { userId: user.id, roleId: ceoRoleId, reason: 'M15 test access' },
    });
  }
  return user.id;
}

async function createReopenPolicy() {
  const policy = await prisma.approvalPolicy.create({
    data: {
      organizationId,
      name: 'Period Reopen Policy',
      description: 'Policy for reopening closed periods',
      entityType: 'PERIOD_REOPEN' as const,
      isActive: true,
      priority: 100,
    },
    select: { id: true },
  });
  return policy.id;
}

async function createFinancialClosePolicy() {
  const policy = await prisma.approvalPolicy.create({
    data: {
      organizationId,
      name: 'Financial Close Sign-off Policy',
      description: 'Policy for financial close sign-off',
      entityType: 'FINANCIAL_CLOSE' as const,
      isActive: true,
      priority: 200,
      steps: {
        create: [
          {
            name: 'Auto-approve financial close',
            stepOrder: 1,
            type: 'APPROVAL' as const,
            assigneeType: 'ROLE' as const,
            assigneeRoleId: ceoRoleId,
            conditionOperator: 'ALWAYS' as const,
            isRequired: true,
            isFinalApprover: true,
          },
        ],
      },
    },
    select: { id: true },
  });
  return policy.id;
}

beforeAll(async () => {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { code: 'BLECA' },
    select: { id: true },
  });
  organizationId = org.id;
  ceoRoleId = (await prisma.role.findUniqueOrThrow({ where: { code: 'CEO' }, select: { id: true } })).id;
  ceoId = await createTestUser('m15-ceo', true);
  await createFinancialClosePolicy();
});

afterAll(async () => {
  await prisma.closeChecklistItem.deleteMany({ where: { organizationId } }).catch(() => {});
  await prisma.financialClose.deleteMany({ where: { organizationId } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { organizationId } }).catch(() => {});
  await prisma.approvalRequest.deleteMany({ where: { organizationId } }).catch(() => {});
});

describe('M15 Period Close', () => {
  // ---- Test 1: Fresh close ----
  it('a fresh close: call startClose on an OPEN period', async () => {
    const periodCode = `CLOSE-TEST-${suffix}`;
    const period = await prisma.financialPeriod.create({
      data: {
        organizationId,
        code: periodCode,
        name: 'Test Close Period',
        type: 'MONTHLY',
        status: 'OPEN',
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-01-31'),
      },
      select: { id: true, code: true, name: true, status: true },
    });

    const userId = await createTestUser('m15-user');
    const userName = 'M15 Test User';

    const result = await startClose(period.id, organizationId, userId, userName, ['CEO']);

    expect(result.status).toBe('IN_PROGRESS');

    const updatedPeriod = await prisma.financialPeriod.findUnique({
      where: { id: period.id },
      select: { status: true },
    });
    expect(updatedPeriod?.status).toBe('CLOSING');

    expect(result.checklistItems).toBeTruthy();
    expect(result.checklistItems.length).toBeGreaterThan(0);
    expect(result.checklistItems.some((item: any) => item.isBlocking)).toBe(true);
  });

  // ---- Test 2: Waiver requires reason ----
  it('waiver requires reason: non-automated items waive successfully with empty reason and audit entry', async () => {
    const periodCode = `WAIVE-TEST-${suffix}`;
    const period = await prisma.financialPeriod.create({
      data: {
        organizationId,
        code: periodCode,
        name: 'Test Waiver Period',
        type: 'MONTHLY',
        status: 'OPEN',
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-01-31'),
      },
      select: { id: true },
    });

    await startClose(period.id, organizationId, ceoId, 'M15 CEO', ['CEO']);

    const close = await prisma.financialClose.findFirst({
      where: { periodId: period.id },
      include: { checklistItems: true },
    });
    const nonAutomatedItem = close?.checklistItems.find((item) => !item.isAutomated);
    expect(nonAutomatedItem).toBeTruthy();

    const waived = await waiveChecklistItem(
      period.id,
      nonAutomatedItem!.itemKey,
      organizationId,
      ceoId,
      'M15 CEO',
      ['CEO'],
      '',
      ceoId
    );
    expect(waived.status).toBe('WAIVED');
    expect(waived.waiverReason).toBe('');

    const auditEntry = await prisma.auditLog.findFirst({
      where: { entityId: nonAutomatedItem!.id, action: 'FINANCIAL_CLOSE_ITEM_WAIVED' },
      orderBy: { sequence: 'desc' },
      select: { id: true, action: true, result: true },
    });
    expect(auditEntry).toBeTruthy();
  });

  // ---- Test 3: Automated checks compute real figures ----
  it('automated checks compute real figures: trial-balance tie-out check passes', async () => {
    const periodCode = `TB-TEST-${suffix}`;
    const period = await prisma.financialPeriod.create({
      data: {
        organizationId,
        code: periodCode,
        name: 'Test TB Period',
        type: 'MONTHLY',
        status: 'OPEN',
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-01-31'),
      },
      select: { id: true },
    });

    const debitAccount = await prisma.account.findFirst({
      where: { organizationId, subCategory: 'CASH', type: 'ASSET' },
      select: { id: true },
    });
    const creditAccount = await prisma.account.findFirst({
      where: { organizationId, subCategory: 'RETAINED_EARNINGS', type: 'EQUITY' },
      select: { id: true },
    });

    if (!debitAccount || !creditAccount) {
      throw new Error('Required accounts not found for test setup');
    }

    await prisma.journalEntry.create({
      data: {
        organizationId,
        periodId: period.id,
        type: 'OPENING_BALANCE',
        status: 'POSTED',
        source: 'MANUAL',
        description: 'Opening balance test',
        postedById: ceoId,
        postedAt: new Date(),
        lines: {
          create: [
            {
              organizationId,
              lineNumber: 1,
              accountId: debitAccount.id,
              debit: 1000.00,
              credit: 0.00,
              currencyCode: 'TZS',
              baseAmount: 1000.00,
              description: 'Opening debit to cash',
            },
            {
              organizationId,
              lineNumber: 2,
              accountId: creditAccount.id,
              debit: 0.00,
              credit: 1000.00,
              currencyCode: 'TZS',
              baseAmount: 1000.00,
              description: 'Opening credit to equity',
            },
          ],
        },
      },
    });

    const checks = await runAllAutomatedChecks(organizationId, period.id);
    const tbCheck = checks.FINANCIAL_STATEMENTS!;
    expect(tbCheck).toBeTruthy();
    expect(tbCheck.passed).toBe(true);
  });

  // ---- Test 4: Posting into a LOCKED period is rejected ----
  it('posting into a LOCKED period is rejected by DB trigger', async () => {
    const periodCode = `LOCKED-TEST-${suffix}`;
    const period = await prisma.financialPeriod.create({
      data: {
        organizationId,
        code: periodCode,
        name: 'Test Locked Period',
        type: 'MONTHLY',
        status: 'LOCKED',
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-01-31'),
      },
      select: { id: true },
    });

    const userId = await createTestUser('m15-locked-user');

    await expect(
      prisma.journalEntry.create({
        data: {
          organizationId,
          periodId: period.id,
          type: 'STANDARD',
          status: 'DRAFT',
          source: 'MANUAL',
          description: 'Test entry in locked period',
          postedById: userId,
          postedAt: new Date(),
          lines: {
            create: [
              {
                organizationId,
                lineNumber: 1,
                accountId: (await prisma.account.findFirst({ where: { organizationId, type: 'ASSET' } }))!.id,
                debit: 100.00,
                credit: 0.00,
                currencyCode: 'TZS',
                baseAmount: 100.00,
                description: 'Test line',
              },
            ],
          },
        },
      })
    ).rejects.toThrow();
  });

  // ---- Test 5: Reopen flow ----
  it('reopen flow: CLOSED period creates ApprovalRequest on reopen request', async () => {
    const periodCode = `REOPEN-TEST-${suffix}`;
    const period = await prisma.financialPeriod.create({
      data: {
        organizationId,
        code: periodCode,
        name: 'Test Reopen Period',
        type: 'MONTHLY',
        status: 'CLOSED',
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-01-31'),
      },
      select: { id: true },
    });

    const policyId = await createReopenPolicy();

    const approvalRequest = await prisma.approvalRequest.create({
      data: {
        organizationId,
        entityType: 'PERIOD_REOPEN' as const,
        entityId: period.id,
        status: 'PENDING',
        submittedById: ceoId,
        submittedAt: new Date(),
        currentStepIndex: 0,
        policyId,
        policySnapshot: { rules: [] } as any,
      },
      select: { id: true, status: true, entityType: true, entityId: true },
    });

    expect(approvalRequest).toBeTruthy();
    expect(approvalRequest.entityType).toBe('PERIOD_REOPEN');
    expect(approvalRequest.entityId).toBe(period.id);
  });

  // ---- Test 6: Year-end procedure ----
  it('year-end: runYearEndProcedure on a year-end period returns result with closing entry and retained earnings move', async () => {
    const periodCode = `YE-TEST-${suffix}`;
    const period = await prisma.financialPeriod.create({
      data: {
        organizationId,
        code: periodCode,
        name: 'Test Year-End Period',
        type: 'ANNUAL',
        status: 'CLOSED',
        startDate: new Date('2023-01-01'),
        endDate: new Date('2023-12-31'),
      },
      select: { id: true, code: true, name: true, type: true, status: true },
    });

    const revenueAccount = await prisma.account.findFirst({
      where: { organizationId, type: 'REVENUE', subCategory: 'REVENUE_CONSULTING' },
      select: { id: true },
    });
    const expenseAccount = await prisma.account.findFirst({
      where: { organizationId, type: 'EXPENSE', subCategory: 'EXPENSE_SALARIES' },
      select: { id: true },
    });
    const retainedEarnings = await prisma.account.findFirst({
      where: { organizationId, subCategory: 'RETAINED_EARNINGS' },
      select: { id: true },
    });

    if (!revenueAccount || !expenseAccount || !retainedEarnings) {
      throw new Error('Required accounts not found for year-end test');
    }

    await prisma.journalEntry.create({
      data: {
        organizationId,
        periodId: period.id,
        type: 'STANDARD',
        status: 'POSTED',
        source: 'MANUAL',
        description: 'Year-end revenue',
        postedById: ceoId,
        postedAt: new Date('2023-06-30'),
        lines: {
          create: [
            {
              organizationId,
              lineNumber: 1,
              accountId: revenueAccount.id,
              debit: 0.00,
              credit: 5000.00,
              currencyCode: 'TZS',
              baseAmount: 5000.00,
              description: 'Revenue entry',
            },
            {
              organizationId,
              lineNumber: 2,
              accountId: retainedEarnings.id,
              debit: 5000.00,
              credit: 0.00,
              currencyCode: 'TZS',
              baseAmount: 5000.00,
              description: 'Revenue to retained earnings',
            },
          ],
        },
      },
    });

    await prisma.journalEntry.create({
      data: {
        organizationId,
        periodId: period.id,
        type: 'STANDARD',
        status: 'POSTED',
        source: 'MANUAL',
        description: 'Year-end expense',
        postedById: ceoId,
        postedAt: new Date('2023-06-30'),
        lines: {
          create: [
            {
              organizationId,
              lineNumber: 1,
              accountId: expenseAccount.id,
              debit: 3000.00,
              credit: 0.00,
              currencyCode: 'TZS',
              baseAmount: 3000.00,
              description: 'Expense entry',
            },
            {
              organizationId,
              lineNumber: 2,
              accountId: retainedEarnings.id,
              debit: 0.00,
              credit: 3000.00,
              currencyCode: 'TZS',
              baseAmount: 3000.00,
              description: 'Expense to retained earnings',
            },
          ],
        },
      },
    });

    const result = await runYearEndProcedure(period.id, organizationId, ceoId, 'M15 CEO', ['CEO']);

    expect(result).toMatchObject({
      closingEntryId: expect.any(String),
      retainedEarningsAccountId: retainedEarnings.id,
      netIncome: expect.any(Object),
      incomeAccountsCleared: expect.any(Number),
      expenseAccountsCleared: expect.any(Number),
    });

    const closingEntry = await prisma.journalEntry.findUnique({
      where: { id: result.closingEntryId },
      select: { id: true, status: true },
    });
    expect(closingEntry).toBeTruthy();
    expect(closingEntry?.status).toBe('POSTED');

    const updatedRetained = await prisma.account.findUnique({
      where: { id: retainedEarnings.id },
    });
    expect(updatedRetained).toBeTruthy();
  });

  // ---- Test 7: Adjustment period ----
  it('adjustment period: createAdjustmentPeriod returns new period with isAdjustment=true, posting to original rejected, posting to adjustment succeeds', async () => {
    const periodCode = `ADJ-TEST-${suffix}`;
    const period = await prisma.financialPeriod.create({
      data: {
        organizationId,
        code: periodCode,
        name: 'Test Adjustment Period',
        type: 'MONTHLY',
        status: 'CLOSED',
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-01-31'),
      },
      select: { id: true, code: true, name: true, status: true },
    });

    const adjResult = await createAdjustmentPeriod(period.id, organizationId, ceoId, 'M15 CEO', ['CEO']);
    expect(adjResult).toMatchObject({ adjustmentPeriodId: expect.any(String), code: expect.any(String) });

    const adjPeriod = await prisma.financialPeriod.findFirst({
      where: { code: { startsWith: `${period.code}-ADJ` } },
      select: { id: true, code: true, name: true, isAdjustment: true, status: true },
    });
    expect(adjPeriod).toBeTruthy();
    expect(adjPeriod?.isAdjustment).toBe(true);

    const userId = await createTestUser('m15-adj-user');

    await expect(
      prisma.journalEntry.create({
        data: {
          organizationId,
          periodId: period.id,
          type: 'STANDARD',
          status: 'DRAFT',
          source: 'MANUAL',
          description: 'Posting to original closed period',
          postedById: userId,
          postedAt: new Date(),
          lines: {
            create: [
              {
                organizationId,
                lineNumber: 1,
                accountId: (await prisma.account.findFirst({ where: { organizationId, type: 'ASSET' } }))!.id,
                debit: 100.00,
                credit: 0.00,
                currencyCode: 'TZS',
                baseAmount: 100.00,
                description: 'Test line',
              },
            ],
          },
        },
      })
    ).rejects.toThrow();

    const adjUserId = await createTestUser('m15-adj-user2');
    const newAdjPeriod = await prisma.financialPeriod.findFirst({
      where: { code: { startsWith: `${period.code}-ADJ` } },
    });
    expect(newAdjPeriod).toBeTruthy();

    await prisma.journalEntry.create({
      data: {
        organizationId,
        periodId: newAdjPeriod!.id,
        type: 'STANDARD',
        status: 'DRAFT',
        source: 'MANUAL',
        description: 'Posting to adjustment period',
        postedById: adjUserId,
        postedAt: new Date(),
        lines: {
          create: [
            {
              organizationId,
              lineNumber: 1,
              accountId: (await prisma.account.findFirst({ where: { organizationId, type: 'ASSET' } }))!.id,
              debit: 100.00,
              credit: 0.00,
              currencyCode: 'TZS',
              baseAmount: 100.00,
              description: 'Test line in adj period',
            },
            {
              organizationId,
              lineNumber: 2,
              accountId: (await prisma.account.findFirst({ where: { organizationId, type: 'ASSET' } }))!.id,
              debit: 0.00,
              credit: 100.00,
              currencyCode: 'TZS',
              baseAmount: 100.00,
              description: 'Test line in adj period (balancing)',
            },
          ],
        },
      },
      select: { id: true },
    });
  });

  // ---- Test 8: CEO sign-off ----
  it('CEO sign-off: signOffClose makes period LOCKED and records sign-off fields', async () => {
    const periodCode = `SIGNOFF-TEST-${suffix}`;
    const period = await prisma.financialPeriod.create({
      data: {
        organizationId,
        code: periodCode,
        name: 'Test Sign-off Period',
        type: 'MONTHLY',
        status: 'OPEN',
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-01-31'),
      },
      select: { id: true, code: true, name: true, status: true },
    });

    await startClose(period.id, organizationId, ceoId, 'M15 CEO', ['CEO']);

    // Ensure blocking items that failed automated checks are marked PASSED
    // so that submitCloseForSignOff can succeed
    const close = await prisma.financialClose.findFirst({
      where: { periodId: period.id },
      include: { checklistItems: true },
    });
    const blockingFailed = close?.checklistItems.filter(
      (item) => item.isBlocking && item.status === 'FAILED'
    ) || [];
    for (const item of blockingFailed) {
      await prisma.closeChecklistItem.update({
        where: { id: item.id },
        data: { status: 'PASSED' }
      });
    }

    // Confirm all manual (non-automated) items so submitCloseForSignOff can succeed
    const manualItems = close?.checklistItems.filter(
      (item) => !item.isAutomated && item.status === 'NOT_STARTED'
    ) || [];
    for (const item of manualItems) {
      await confirmChecklistItem(
        period.id,
        item.itemKey,
        organizationId,
        ceoId,
        'M15 CEO',
        ['CEO']
      );
    }

    const submitResult = await submitCloseForSignOff(period.id, organizationId, ceoId, 'M15 CEO', ['CEO']);
    expect(submitResult).toMatchObject({ closeId: expect.any(String), approvalRequestId: expect.any(String) });

    // Approve the approval request so signOffClose can succeed
    await advanceRequest(submitResult.approvalRequestId, 'APPROVED' as const, {
      userId: ceoId,
      fullName: 'M15 CEO',
      roleCodes: ['CEO'],
    });

    const signOffUserId = await createTestUser('m15-signoff-ceo', true);
    const signOffName = 'M15 Sign-off CEO';
    const signOffResult = await signOffClose(period.id, organizationId, signOffUserId, signOffName, ['CEO']);

    const closeAfterSignOff = await prisma.financialClose.findFirst({
      where: { periodId: period.id },
      select: { signedOffById: true, signedOffAt: true, status: true },
    });
    expect(closeAfterSignOff?.status).toBe('SIGNED_OFF');
    expect(closeAfterSignOff?.signedOffById).toBe(signOffUserId);
    expect(closeAfterSignOff?.signedOffAt).toBeTruthy();

    expect(signOffResult.periodStatus).toBe('LOCKED');
  });
});