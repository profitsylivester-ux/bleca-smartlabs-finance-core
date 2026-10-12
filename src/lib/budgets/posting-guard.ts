import { Prisma } from '@/generated/prisma/client';
import { createApprovalRequest } from '@/lib/approvals/engine';
import type { ActorContext } from '@/lib/kernel/context';
import { ConflictError, ValidationError } from '@/lib/kernel/errors';
import { evaluatePostingOverBudget, validateRestrictedFundingExpense } from './availability';

export interface BudgetPostingCandidate {
  id: string;
  organizationId: string;
  date: Date;
  amount: Prisma.Decimal | number | string;
  currencyCode: string;
  accountId: string | null;
  projectId: string | null;
  departmentId: string | null;
  costCentreId: string | null;
  fundingSourceId: string | null;
  submittedById: string | null;
}

export interface BudgetPostingApproval {
  overBudget: boolean;
  approved: boolean;
  approvalRequestId: string | null;
  budgetId: string | null;
  available: string;
  projected: string;
}

export async function ensureBudgetPostingApproval(
  tx: Prisma.TransactionClient,
  candidate: BudgetPostingCandidate,
  actor: ActorContext,
): Promise<BudgetPostingApproval> {
  const check = await evaluateCandidate(tx, candidate);
  if (!check.overBudget) {
    return {
      overBudget: false,
      approved: true,
      approvalRequestId: null,
      budgetId: check.budgetId,
      available: check.available.toString(),
      projected: check.projected.toString(),
    };
  }

  const requests = await tx.approvalRequest.findMany({
    where: {
      organizationId: candidate.organizationId,
      entityType: 'TRANSACTION',
      entityId: candidate.id,
      status: { in: ['PENDING', 'IN_PROGRESS', 'APPROVED'] },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, policySnapshot: true },
  });
  const overBudgetRequests = requests.filter((request) =>
    snapshotHasOverBudgetCondition(request.policySnapshot),
  );
  const approvedRequest = overBudgetRequests.find((request) => request.status === 'APPROVED');
  if (approvedRequest) {
    return {
      overBudget: true,
      approved: true,
      approvalRequestId: approvedRequest.id,
      budgetId: check.budgetId,
      available: check.available.toString(),
      projected: check.projected.toString(),
    };
  }

  let requestId = overBudgetRequests[0]?.id ?? null;
  if (!requestId) {
    try {
      const request = await createApprovalRequest(
        {
          organizationId: candidate.organizationId,
          entityType: 'TRANSACTION',
          entityId: candidate.id,
          amount: Number(candidate.amount),
          currencyCode: candidate.currencyCode,
          submittedById: candidate.submittedById ?? actor.userId,
          context: {
            organizationId: candidate.organizationId,
            entityType: 'TRANSACTION',
            entityId: candidate.id,
            submittedById: candidate.submittedById ?? actor.userId,
            requiredCondition: 'OVER_BUDGET',
            amount: Number(candidate.amount),
            currencyCode: candidate.currencyCode,
            transactionDate: candidate.date,
            accountId: candidate.accountId,
            projectId: candidate.projectId,
            departmentId: candidate.departmentId,
            costCentreId: candidate.costCentreId,
            fundingSourceId: candidate.fundingSourceId,
          },
        },
        tx,
      );
      requestId = request.id;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('No applicable approval policy')) {
        throw new ValidationError(
          'An OVER_BUDGET approval policy must be configured before this transaction can be posted.',
          { transactionId: candidate.id, budgetId: check.budgetId },
        );
      }
      throw error;
    }
  }

  return {
    overBudget: true,
    approved: false,
    approvalRequestId: requestId,
    budgetId: check.budgetId,
    available: check.available.toString(),
    projected: check.projected.toString(),
  };
}

export async function assertBudgetPostingApproved(
  tx: Prisma.TransactionClient,
  candidate: BudgetPostingCandidate,
): Promise<void> {
  const check = await evaluateCandidate(tx, candidate);
  if (!check.overBudget) return;

  const requests = await tx.approvalRequest.findMany({
    where: {
      organizationId: candidate.organizationId,
      entityType: 'TRANSACTION',
      entityId: candidate.id,
      status: 'APPROVED',
    },
    select: { id: true, policySnapshot: true },
  });
  const approved = requests.find((request) => snapshotHasOverBudgetCondition(request.policySnapshot));
  if (!approved) {
    throw new ConflictError(
      'This transaction exceeds available budget and needs an approved OVER_BUDGET request before posting.',
      {
        transactionId: candidate.id,
        budgetId: check.budgetId,
        available: check.available.toString(),
        projected: check.projected.toString(),
      },
    );
  }
}

async function evaluateCandidate(
  tx: Prisma.TransactionClient,
  candidate: BudgetPostingCandidate,
) {
  if (!candidate.accountId) {
    throw new ValidationError('Cannot post a transaction without an account.');
  }

  await validateRestrictedFundingExpense(tx, {
    organizationId: candidate.organizationId,
    accountId: candidate.accountId,
    fundingSourceId: candidate.fundingSourceId,
    projectId: candidate.projectId,
  });

  return evaluatePostingOverBudget(tx, {
    organizationId: candidate.organizationId,
    accountId: candidate.accountId,
    amount: candidate.amount,
    currencyCode: candidate.currencyCode,
    asOf: candidate.date,
    projectId: candidate.projectId,
    departmentId: candidate.departmentId,
    costCentreId: candidate.costCentreId,
    fundingSourceId: candidate.fundingSourceId,
  });
}

function snapshotHasOverBudgetCondition(value: Prisma.JsonValue): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const steps = value.steps;
  if (!Array.isArray(steps)) return false;
  return steps.some((step) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return false;
    return step.conditionOperator === 'OVER_BUDGET';
  });
}
