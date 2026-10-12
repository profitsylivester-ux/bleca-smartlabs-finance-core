import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PrismaClient,
  type BudgetLevel,
  type AccountSubCategory,
} from '@/generated/prisma/client';
import { seedTestFixtures } from '../setup/fixtures';
import type { ActorContext } from '@/lib/kernel/context';
import type { AuditActor } from '@/lib/audit/types';
import {
  activateBudget,
  approveBudget,
  approveRevision,
  approveTransfer,
  createBudget,
  createCommitment,
  createRevision,
  createScenario,
  createTransfer,
  getBudgetVsActual,
  listBudgetScenarios,
  listBudgetRevisions,
  settleCommitment,
  submitBudget,
} from '@/lib/budgets/service';
import { ensureBudgetPostingApproval } from '@/lib/budgets/posting-guard';
import { TransactionService } from '@/lib/transactions/service';
import { advanceRequest } from '@/lib/approvals/engine';
import { ConflictError, ValidationError } from '@/lib/kernel/errors';

const prisma = new PrismaClient();
const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const service = new TransactionService();
const START_DATE = new Date('2025-01-01T00:00:00.000Z');
const END_DATE = new Date('2030-12-31T23:59:59.999Z');

let organizationId: string;
let financeActor: ActorContext;
let ceoActor: ActorContext;
let financeAuditActor: AuditActor;
let ceoAuditActor: AuditActor;
let departmentId: string;
let projectId: string;
let unrestrictedFundingId: string;
let restrictedFundingId: string;
let liabilityAccountId: string;
let openPeriodId: string;
let accountCounter = 0;
let budgetCounter = 0;
let transactionCounter = 0;

beforeAll(async () => {
  await seedTestFixtures(prisma);
  const organization = await prisma.organization.findUniqueOrThrow({
    where: { code: 'BLECA' },
    select: { id: true },
  });
  organizationId = organization.id;

  const financeRole = await prisma.role.findUniqueOrThrow({
    where: { code: 'FINANCE_OFFICER' },
    select: { id: true },
  });
  const ceoRole = await prisma.role.findUniqueOrThrow({
    where: { code: 'CEO' },
    select: { id: true, isFinalApprover: true },
  });
  const financeUser = await createTestUser('finance', financeRole.id, 'FINANCE_OFFICER');
  const ceoUser = await createTestUser('ceo', ceoRole.id, 'CEO');
  financeActor = {
    userId: financeUser.id,
    email: financeUser.email,
    fullName: financeUser.fullName,
    roleCodes: ['FINANCE_OFFICER'],
    isFinalApprover: false,
    organizationId,
    sessionId: null,
    mfaSatisfiedAt: null,
    stepUpSatisfiedAt: null,
    stepUpExpiresAt: null,
  };
  ceoActor = {
    userId: ceoUser.id,
    email: ceoUser.email,
    fullName: ceoUser.fullName,
    roleCodes: ['CEO'],
    isFinalApprover: ceoRole.isFinalApprover,
    organizationId,
    sessionId: null,
    mfaSatisfiedAt: null,
    stepUpSatisfiedAt: null,
    stepUpExpiresAt: null,
  };
  financeAuditActor = {
    id: financeUser.id,
    name: financeUser.fullName,
    roleCodes: financeActor.roleCodes,
  };
  ceoAuditActor = {
    id: ceoUser.id,
    name: ceoUser.fullName,
    roleCodes: ceoActor.roleCodes,
  };

  const department = await prisma.department.create({
    data: {
      organizationId,
      code: `M9-${suffix}`,
      name: `M9 Test Department ${suffix}`,
    },
    select: { id: true },
  });
  departmentId = department.id;
  projectId = (await prisma.project.findFirstOrThrow({
    where: { organizationId, code: 'IVENTIKA' },
    select: { id: true },
  })).id;
  unrestrictedFundingId = (await prisma.fundingSource.findFirstOrThrow({
    where: { organizationId, code: 'UNRESTRICTED' },
    select: { id: true },
  })).id;
  restrictedFundingId = (await prisma.fundingSource.findFirstOrThrow({
    where: { organizationId, code: 'RESTRICTED-GRANT' },
    select: { id: true },
  })).id;
  liabilityAccountId = (await prisma.account.findFirstOrThrow({
    where: { organizationId, type: 'LIABILITY', status: 'ACTIVE', isPostable: true },
    select: { id: true },
  })).id;
  openPeriodId = (await prisma.financialPeriod.findFirstOrThrow({
    where: { organizationId, status: 'OPEN' },
    orderBy: { startDate: 'asc' },
    select: { id: true },
  })).id;

  await prisma.approvalPolicy.create({
    data: {
      organizationId,
      name: `M9 over-budget approval ${suffix}`,
      description: 'Integration policy for the OVER_BUDGET transaction condition.',
      entityType: 'TRANSACTION',
      isActive: true,
      priority: 1,
      steps: {
        create: [{
          stepOrder: 1,
          name: 'CEO over-budget approval',
          type: 'APPROVAL',
          assigneeType: 'ROLE',
          assigneeRoleId: ceoRole.id,
          resolutionMode: 'ANY',
          conditionOperator: 'OVER_BUDGET',
          isRequired: true,
          isFinalApprover: true,
        }],
      },
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('M9 budget management and source-based availability', () => {
  it.each([
    ['COMPANY', {}],
    ['DEPARTMENT', { departmentId: () => departmentId }],
    ['PROJECT', { projectId: () => projectId }],
    ['FUNDING', { fundingSourceId: () => unrestrictedFundingId }],
    ['ACTIVITY', { activity: () => `activity-${suffix}` }],
  ] as const)('recomputes exact availability for %s budgets', async (level, dimensionFactory) => {
    const accountId = await createExpenseAccount('EXPENSE_OTHER');
    const dimensions = resolveDimensions(dimensionFactory);
    const budgetId = await createActiveBudget(level, [{ accountId, amount: '1000.250000' }], dimensions);
    const budgetLineId = await getBudgetLineId(budgetId, accountId);
    await prisma.$transaction((tx) => createCommitment(
      tx,
      {
        organizationId,
        budgetId,
        budgetLineId,
        accountId,
        source: 'MANUAL',
        description: 'M9 formula reservation',
        amount: '100.125000',
        currencyCode: 'TZS',
        commitmentDate: new Date(),
        projectId: dimensions.projectId ?? null,
        departmentId: dimensions.departmentId ?? null,
        fundingSourceId: dimensions.fundingSourceId ?? null,
        createdById: financeActor.userId,
      },
      financeAuditActor,
    ));

    const transaction = await createApprovedExpense(accountId, '250.125000', dimensions);
    await postTransaction(transaction.id);

    const view = await prisma.$transaction((tx) => getBudgetVsActual(tx, budgetId, organizationId));
    expect(view.budget.approved).toBe('1000.25');
    expect(view.budget.committed).toBe('100.125');
    expect(view.budget.actual).toBe('250.125');
    expect(view.budget.available).toBe('650');
    expect(view.lines[0]?.available).toBe('650');
  });

  it('applies a cost-centre refinement together with the primary budget scope', async () => {
    const accountId = await createExpenseAccount('EXPENSE_OTHER');
    const costCentre = await prisma.costCentre.create({
      data: { organizationId, code: `M9-CC-${suffix}`, name: `M9 Cost Centre ${suffix}` },
      select: { id: true },
    });
    const otherCostCentre = await prisma.costCentre.create({
      data: { organizationId, code: `M9-CC-OTHER-${suffix}`, name: `M9 Other Cost Centre ${suffix}` },
      select: { id: true },
    });
    const budgetId = await createActiveBudget(
      'PROJECT',
      [{ accountId, amount: '1000' }],
      { projectId, costCentreId: costCentre.id },
    );

    await postTransaction((await createApprovedExpense(accountId, '100', {
      projectId,
      costCentreId: costCentre.id,
    })).id);
    await postTransaction((await createApprovedExpense(accountId, '350', {
      projectId,
      costCentreId: otherCostCentre.id,
    })).id);

    const view = await prisma.$transaction((tx) => getBudgetVsActual(tx, budgetId, organizationId));
    expect(view.budget.actual).toBe('100');
    expect(view.budget.available).toBe('900');
  });

  it('requires monthly phasing to sum exactly to its budget line amount', async () => {
    const accountId = await createExpenseAccount('EXPENSE_OTHER');
    await expect(prisma.$transaction((tx) => createBudget(
      tx,
      {
        organizationId,
        code: `M9-PHASING-${suffix}`,
        name: 'M9 invalid phasing test',
        type: 'COMPANY',
        periodType: 'MONTHLY',
        startDate: START_DATE,
        endDate: END_DATE,
        currencyCode: 'TZS',
        createdById: financeActor.userId,
        lines: [{ accountId, amount: '100', phasing: { '1': '25', '2': '25' } }],
      },
      financeAuditActor,
    ))).rejects.toBeInstanceOf(ValidationError);
  });

  it('reduces available by the posted expense amount', async () => {
    const accountId = await createExpenseAccount('EXPENSE_OTHER');
    const budgetId = await createActiveBudget('COMPANY', [{ accountId, amount: '2000' }]);
    const transaction = await createApprovedExpense(accountId, '345.75');
    await postTransaction(transaction.id);

    const view = await prisma.$transaction((tx) => getBudgetVsActual(tx, budgetId, organizationId));
    expect(view.budget.actual).toBe('345.75');
    expect(view.budget.available).toBe('1654.25');
  });

  it('reserves a commitment and releases it on settlement', async () => {
    const accountId = await createExpenseAccount('EXPENSE_OTHER');
    const budgetId = await createActiveBudget('COMPANY', [{ accountId, amount: '1000' }]);
    const budgetLineId = await getBudgetLineId(budgetId, accountId);
    const commitment = await prisma.$transaction((tx) => createCommitment(
      tx,
      {
        organizationId,
        budgetId,
        budgetLineId,
        accountId,
        source: 'MANUAL',
        amount: '275.5',
        currencyCode: 'TZS',
        commitmentDate: new Date(),
        createdById: financeActor.userId,
      },
      financeAuditActor,
    ));

    const reserved = await prisma.$transaction((tx) => getBudgetVsActual(tx, budgetId, organizationId));
    expect(reserved.budget.committed).toBe('275.5');
    expect(reserved.budget.available).toBe('724.5');

    await prisma.$transaction((tx) => settleCommitment(tx, commitment.id, organizationId, financeAuditActor));
    const released = await prisma.$transaction((tx) => getBudgetVsActual(tx, budgetId, organizationId));
    expect(released.budget.committed).toBe('0');
    expect(released.budget.available).toBe('1000');
  });

  it('blocks an over-budget post until the OVER_BUDGET approval request is approved', async () => {
    const accountId = await createExpenseAccount('EXPENSE_OTHER');
    const budgetId = await createActiveBudget('COMPANY', [{ accountId, amount: '100' }]);
    const transaction = await createApprovedExpense(accountId, '150');

    await expect(postTransaction(transaction.id)).rejects.toBeInstanceOf(ConflictError);

    const candidate = await prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } });
    const approval = await prisma.$transaction((tx) => ensureBudgetPostingApproval(tx, candidate, financeActor));
    expect(approval.overBudget).toBe(true);
    expect(approval.approved).toBe(false);
    expect(approval.approvalRequestId).toBeTruthy();

    const approvedRequest = await advanceRequest(
      approval.approvalRequestId!,
      'APPROVED',
      { userId: ceoActor.userId, fullName: ceoActor.fullName, roleCodes: ceoActor.roleCodes },
    );
    expect(approvedRequest.request.status).toBe('APPROVED');

    const posted = await postTransaction(transaction.id);
    expect(posted).toBe('POSTED');
    const view = await prisma.$transaction((tx) => getBudgetVsActual(tx, budgetId, organizationId));
    expect(view.budget.available).toBe('-50');
  });

  it('rejects expenses outside restricted funding project and cost-category rules', async () => {
    const travelAccountId = await createExpenseAccount('EXPENSE_TRANSPORT');
    const ineligibleAccountId = await createExpenseAccount('EXPENSE_OTHER');
    const outsideProject = await prisma.project.create({
      data: {
        organizationId,
        code: `M9-OUT-${suffix}`,
        name: `M9 Outside Project ${suffix}`,
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    const budgetId = await createActiveBudget(
      'FUNDING',
      [
        { accountId: travelAccountId, amount: '1000' },
        { accountId: ineligibleAccountId, amount: '1000' },
      ],
      { fundingSourceId: restrictedFundingId },
    );
    expect(budgetId).toBeTruthy();

    const wrongProject = await createApprovedExpense(travelAccountId, '25', {
      projectId: outsideProject.id,
      fundingSourceId: restrictedFundingId,
    });
    await expect(postTransaction(wrongProject.id)).rejects.toBeInstanceOf(ValidationError);

    const wrongCategory = await createApprovedExpense(ineligibleAccountId, '25', {
      projectId,
      fundingSourceId: restrictedFundingId,
    });
    await expect(postTransaction(wrongCategory.id)).rejects.toBeInstanceOf(ValidationError);
  });

  it('keeps revision before/after snapshots and changes live lines only after approval', async () => {
    const accountId = await createExpenseAccount('EXPENSE_OTHER');
    const budgetId = await createActiveBudget('COMPANY', [{ accountId, amount: '1000' }]);
    const budgetLineId = await getBudgetLineId(budgetId, accountId);
    const revision = await prisma.$transaction((tx) => createRevision(
      tx,
      {
        budgetId,
        organizationId,
        reason: 'Increase approved allocation',
        changes: [{ budgetLineId, afterAmount: '1200.5' }],
      },
      financeAuditActor,
    ));

    expect((await prisma.budgetLine.findUniqueOrThrow({ where: { id: budgetLineId } })).amount.toString()).toBe('1000');
    const pending = await prisma.$transaction((tx) => listBudgetRevisions(tx, budgetId, organizationId));
    expect(pending[0]?.lines[0]?.beforeAmount).toBe('1000');
    expect(pending[0]?.lines[0]?.afterAmount).toBe('1200.5');

    await prisma.$transaction((tx) => approveRevision(tx, revision.id, organizationId, ceoAuditActor));
    expect((await prisma.budgetLine.findUniqueOrThrow({ where: { id: budgetLineId } })).amount.toString()).toBe('1200.5');
  });

  it('applies transfers to both lines and records the approval in the audit trail', async () => {
    const fromAccountId = await createExpenseAccount('EXPENSE_OTHER');
    const toAccountId = await createExpenseAccount('EXPENSE_OTHER');
    const budgetId = await createActiveBudget('COMPANY', [
      { accountId: fromAccountId, amount: '1000' },
      { accountId: toAccountId, amount: '500' },
    ]);
    const fromLineId = await getBudgetLineId(budgetId, fromAccountId);
    const toLineId = await getBudgetLineId(budgetId, toAccountId);
    const transfer = await prisma.$transaction((tx) => createTransfer(
      tx,
      { budgetId, organizationId, fromLineId, toLineId, amount: '200', reason: 'Align project allocations' },
      financeAuditActor,
    ));

    await prisma.$transaction((tx) => approveTransfer(tx, transfer.id, organizationId, ceoAuditActor));
    const fromLine = await prisma.budgetLine.findUniqueOrThrow({ where: { id: fromLineId } });
    const toLine = await prisma.budgetLine.findUniqueOrThrow({ where: { id: toLineId } });
    expect(fromLine.amount.toString()).toBe('800');
    expect(toLine.amount.toString()).toBe('700');

    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'BUDGET_TRANSFER', entityId: transfer.id, action: 'BUDGET_TRANSFER_APPROVED' },
      select: { id: true },
    });
    expect(audit).not.toBeNull();
  });

  it('projects a scenario without changing the budget or its availability', async () => {
    const accountId = await createExpenseAccount('EXPENSE_OTHER');
    const budgetId = await createActiveBudget('COMPANY', [{ accountId, amount: '1000' }]);
    const transaction = await createApprovedExpense(accountId, '300');
    await postTransaction(transaction.id);
    const lineId = await getBudgetLineId(budgetId, accountId);

    const before = await prisma.$transaction((tx) => getBudgetVsActual(tx, budgetId, organizationId));
    const scenario = await prisma.$transaction((tx) => createScenario(
      tx,
      {
        budgetId,
        organizationId,
        kind: 'WORST_CASE',
        name: 'Spend 150%',
        description: 'Stress projection',
        adjustmentFactor: '1.5',
        createdById: financeActor.userId,
      },
      financeAuditActor,
    ));
    const projections = await prisma.$transaction((tx) => listBudgetScenarios(tx, budgetId, organizationId));
    const after = await prisma.$transaction((tx) => getBudgetVsActual(tx, budgetId, organizationId));
    const line = await prisma.budgetLine.findUniqueOrThrow({ where: { id: lineId } });

    expect(scenario.kind).toBe('WORST_CASE');
    expect(projections[0]?.projectedActual).toBe('450');
    expect(projections[0]?.projectedAvailable).toBe('550');
    expect(line.amount.toString()).toBe('1000');
    expect(after.budget.actual).toBe(before.budget.actual);
    expect(after.budget.available).toBe(before.budget.available);
  });
});

async function createTestUser(label: string, roleId: string, roleCode: string) {
  const email = `${suffix}-${label}@bleca.test`;
  return prisma.user.create({
    data: {
      email,
      emailNormalized: email,
      fullName: `M9 ${label} ${suffix}`,
      status: 'ACTIVE',
      organizationMemberships: { create: { organizationId } },
      userRoles: { create: { roleId, reason: `M9 integration test ${roleCode}` } },
    },
    select: { id: true, email: true, fullName: true },
  });
}

async function createExpenseAccount(subCategory: AccountSubCategory): Promise<string> {
  accountCounter += 1;
  const account = await prisma.account.create({
    data: {
      organizationId,
      code: `M9-${suffix}-${accountCounter}`,
      name: `M9 expense ${accountCounter}`,
      type: 'EXPENSE',
      subCategory,
      normalBalance: 'DEBIT',
      isPostable: true,
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  return account.id;
}

async function createActiveBudget(
  type: BudgetLevel,
  lines: Array<{ accountId: string; amount: string }>,
  dimensions: {
    projectId?: string;
    departmentId?: string;
    fundingSourceId?: string;
    costCentreId?: string;
    activity?: string;
  } = {},
): Promise<string> {
  budgetCounter += 1;
  return prisma.$transaction(async (tx) => {
    const budget = await createBudget(
      tx,
      {
        organizationId,
        code: `M9-${suffix}-${budgetCounter}`,
        name: `M9 ${type} budget ${budgetCounter}`,
        type,
        periodType: 'ANNUAL',
        startDate: START_DATE,
        endDate: END_DATE,
        currencyCode: 'TZS',
        ...dimensions,
        createdById: financeActor.userId,
        lines,
      },
      financeAuditActor,
    );
    await submitBudget(tx, budget.id, organizationId, financeAuditActor);
    await approveBudget(tx, budget.id, organizationId, ceoAuditActor);
    await activateBudget(tx, budget.id, organizationId, ceoAuditActor);
    return budget.id;
  });
}

async function getBudgetLineId(budgetId: string, accountId: string): Promise<string> {
  const line = await prisma.budgetLine.findUniqueOrThrow({
    where: { budgetId_accountId: { budgetId, accountId } },
    select: { id: true },
  });
  return line.id;
}

async function createApprovedExpense(
  accountId: string,
  amount: string,
  dimensions: {
    projectId?: string;
    departmentId?: string;
    fundingSourceId?: string;
    costCentreId?: string;
  } = {},
) {
  transactionCounter += 1;
  return prisma.transaction.create({
    data: {
      organizationId,
      status: 'APPROVED',
      date: new Date(),
      description: `M9 posting ${transactionCounter}`,
      reference: `M9-${suffix}-${transactionCounter}`,
      accountId,
      amount,
      currencyCode: 'TZS',
      paymentMethod: 'CASH',
      projectId: dimensions.projectId ?? null,
      departmentId: dimensions.departmentId ?? null,
      fundingSourceId: dimensions.fundingSourceId ?? null,
      costCentreId: dimensions.costCentreId ?? null,
      createdById: financeActor.userId,
      submittedById: financeActor.userId,
      approvedById: ceoActor.userId,
      approvedAt: new Date(),
    },
    select: { id: true },
  });
}

async function postTransaction(transactionId: string): Promise<string> {
  const posted = await prisma.$transaction((tx) =>
    service._doAction(tx, transactionId, organizationId, financeActor, 'POSTED'),
  );
  return posted.status ?? '';
}

function resolveDimensions<T extends {
  projectId?: () => string;
  departmentId?: () => string;
  fundingSourceId?: () => string;
  activity?: () => string;
}>(dimensionFactory: T): {
  projectId?: string;
  departmentId?: string;
  fundingSourceId?: string;
  activity?: string;
} {
  return {
    ...(dimensionFactory.projectId ? { projectId: dimensionFactory.projectId() } : {}),
    ...(dimensionFactory.departmentId ? { departmentId: dimensionFactory.departmentId() } : {}),
    ...(dimensionFactory.fundingSourceId ? { fundingSourceId: dimensionFactory.fundingSourceId() } : {}),
    ...(dimensionFactory.activity ? { activity: dimensionFactory.activity() } : {}),
  };
}
