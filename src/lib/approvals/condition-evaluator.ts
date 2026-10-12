import { prisma } from '@/lib/db/prisma';
import type { ConditionContext, ApprovalConditionOperator } from './types';
import { Prisma } from '@/generated/prisma/client';
import { evaluatePostingOverBudget } from '@/lib/budgets/availability';

export async function evaluateCondition(
  operator: ApprovalConditionOperator,
  conditionValue: unknown,
  context: ConditionContext,
  tx: Prisma.TransactionClient = prisma
): Promise<boolean> {
  switch (operator) {
    case 'ALWAYS':
      return true;

    case 'AMOUNT_GREATER_THAN':
      if (!conditionValue || typeof conditionValue !== 'object' || !('amount' in conditionValue)) {
        return false;
      }
      const threshold = (conditionValue as { amount: number }).amount;
      return (context.amount ?? 0) > threshold;

    case 'AMOUNT_GREATER_OR_EQUAL':
      if (!conditionValue || typeof conditionValue !== 'object' || !('amount' in conditionValue)) {
        return false;
      }
      const thresholdGe = (conditionValue as { amount: number }).amount;
      return (context.amount ?? 0) >= thresholdGe;

    case 'AMOUNT_LESS_THAN':
      if (!conditionValue || typeof conditionValue !== 'object' || !('amount' in conditionValue)) {
        return false;
      }
      const thresholdLt = (conditionValue as { amount: number }).amount;
      return (context.amount ?? 0) < thresholdLt;

    case 'AMOUNT_BETWEEN':
      if (!conditionValue || typeof conditionValue !== 'object' || !('min' in conditionValue) || !('max' in conditionValue)) {
        return false;
      }
      const { min, max } = conditionValue as { min: number; max: number };
      const amount = context.amount ?? 0;
      return amount >= min && amount <= max;

    case 'PERCENT_OF_BUDGET':
      return await evaluatePercentOfBudget(conditionValue, context, tx);

    case 'OVER_BUDGET':
      return await evaluateOverBudget(context, tx);

    case 'NEW_COUNTERPARTY':
      return await evaluateNewCounterparty(context, tx);

    case 'SUPPLIER_BANK_DETAIL_CHANGED':
      return context.counterpartyBankDetailsChanged === true;

    case 'FUNDING_RESTRICTED':
      return await evaluateFundingRestricted(context, tx);

    case 'CROSS_PROJECT':
      return evaluateCrossProject(context);

    case 'CURRENCY_NOT_BASE':
      return await evaluateCurrencyNotBase(context, tx);

    case 'MANUAL_FLAG':
      return false;

    default:
      return false;
  }
}

async function evaluatePercentOfBudget(
  conditionValue: unknown,
  context: ConditionContext,
  tx: Prisma.TransactionClient
): Promise<boolean> {
  if (!conditionValue || typeof conditionValue !== 'object' || !('percent' in conditionValue)) {
    return false;
  }

  if (!context.accountId || !context.projectId) {
    return false;
  }

  const { percent } = conditionValue as { percent: number };

  const budgets = await tx.budget.findMany({
    where: {
      organizationId: context.organizationId,
      status: 'ACTIVE',
      startDate: { lte: new Date() },
      endDate: { gte: new Date() },
    },
    select: { id: true },
  });

  if (budgets.length === 0) {
    return false;
  }

  const budgetIds = budgets.map((b) => b.id);

  const budgetLines = await tx.budgetLine.findMany({
    where: {
      budgetId: { in: budgetIds },
      accountId: context.accountId,
    },
    select: { amount: true },
  });

  if (budgetLines.length === 0) {
    return false;
  }

  const totalBudget = budgetLines.reduce((sum, bl) => sum + Number(bl.amount), 0);
  const committed = await getCommittedAmount(context, tx);
  const projected = committed + (context.amount ?? 0);

  return projected > totalBudget * (percent / 100);
}

async function evaluateOverBudget(context: ConditionContext, tx: Prisma.TransactionClient): Promise<boolean> {
  if (!context.accountId || !context.currencyCode) {
    return false;
  }
  const result = await evaluatePostingOverBudget(tx, {
    organizationId: context.organizationId,
    accountId: context.accountId,
    amount: context.amount ?? 0,
    currencyCode: context.currencyCode,
    asOf: context.transactionDate,
    projectId: context.projectId,
    departmentId: context.departmentId,
    fundingSourceId: context.fundingSourceId,
    costCentreId: context.costCentreId,
  });
  return result.overBudget;
}

async function evaluateNewCounterparty(context: ConditionContext, tx: Prisma.TransactionClient): Promise<boolean> {
  if (!context.counterpartyId) {
    return false;
  }

  const priorApproved = await tx.transaction.findFirst({
    where: {
      organizationId: context.organizationId,
      status: { in: ['APPROVED', 'POSTED'] },
      description: { contains: context.counterpartyId, mode: 'insensitive' },
    },
    select: { id: true },
  });

  return !priorApproved;
}

async function evaluateFundingRestricted(context: ConditionContext, tx: Prisma.TransactionClient): Promise<boolean> {
  if (!context.fundingSourceId) {
    return false;
  }

  const fundingSource = await tx.fundingSource.findUnique({
    where: { id: context.fundingSourceId },
    select: { isRestricted: true },
  });

  return fundingSource?.isRestricted === true;
}

function evaluateCrossProject(context: ConditionContext): boolean {
  return context.projectId !== null && context.projectId !== undefined;
}

async function evaluateCurrencyNotBase(context: ConditionContext, tx: Prisma.TransactionClient): Promise<boolean> {
  if (!context.currencyCode) {
    return false;
  }

  const org = await tx.organization.findUnique({
    where: { id: context.organizationId },
    select: { baseCurrency: true },
  });

  return org?.baseCurrency !== context.currencyCode;
}

async function getCommittedAmount(context: ConditionContext, tx: Prisma.TransactionClient): Promise<number> {
  const transactions = await tx.transaction.findMany({
    where: {
      organizationId: context.organizationId,
      accountId: context.accountId,
      projectId: context.projectId,
      status: { in: ['APPROVED', 'POSTED'] },
      currencyCode: context.currencyCode,
    },
    select: { amount: true },
  });

  return transactions.reduce((sum, t) => sum + Number(t.amount), 0);
}

export async function evaluateConditions(
  steps: Array<{
    conditionOperator: ApprovalConditionOperator | null;
    conditionValue: Prisma.InputJsonValue | null;
  }>,
  context: ConditionContext,
  tx?: Prisma.TransactionClient
): Promise<Map<number, boolean>> {
  const results = new Map<number, boolean>();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (!step.conditionOperator || step.conditionOperator === 'ALWAYS') {
      results.set(i, true);
      continue;
    }
    const result = await evaluateCondition(step.conditionOperator, step.conditionValue, context, tx);
    results.set(i, result);
  }

  return results;
}
