import { prisma } from '@/lib/db/prisma';
import type { ApprovalEntityType, SelectPolicyResult, PolicySnapshot, ConditionContext } from './types';
import { evaluateConditions } from './condition-evaluator';
import { Prisma } from '@/generated/prisma/client';

export async function selectPolicy(
  entityType: ApprovalEntityType,
  amount: number,
  context: ConditionContext,
  tx: Prisma.TransactionClient = prisma
): Promise<SelectPolicyResult> {
  const policies = await tx.approvalPolicy.findMany({
    where: {
      organizationId: context.organizationId,
      entityType,
      isActive: true,
    },
    include: {
      steps: {
        include: {
          assigneeRole: true,
          assigneeUser: true,
        },
        orderBy: { stepOrder: 'asc' },
      },
    },
    orderBy: { priority: 'asc' },
  });

  console.log('[DEBUG selectPolicy] Found policies:', policies.length, 'for orgId:', context.organizationId, 'entityType:', entityType);
  for (const policy of policies) {
    console.log('[DEBUG selectPolicy] Checking policy:', policy.id, policy.name, 'steps:', policy.steps.length);
    const conditionResults = await evaluateConditions(
      policy.steps.map((s) => ({
        conditionOperator: s.conditionOperator,
        conditionValue: s.conditionValue as Prisma.InputJsonValue | null,
      })),
      context,
      tx
    );

    console.log('[DEBUG selectPolicy] Condition results:', Array.from(conditionResults.entries()));

    const applicableSteps = policy.steps.filter((step, index) => {
      const conditionMet = conditionResults.get(index) ?? false;
      return conditionMet;
    });

    console.log('[DEBUG selectPolicy] Applicable steps:', applicableSteps.length);
    if (applicableSteps.length > 0) {
      const snapshot = buildPolicySnapshot(policy, applicableSteps, conditionResults);
      return { policy, snapshot };
    }
  }

  throw new Error(`No applicable approval policy found for ${entityType} with amount ${amount}`);
}

function buildPolicySnapshot(
  policy: { id: string; name: string; entityType: ApprovalEntityType; createdAt: Date; steps: Array<{
    stepOrder: number;
    name: string;
    type: string;
    assigneeType: string;
    assigneeRoleId: string | null;
    assigneeUserId: string | null;
    resolutionMode: string;
    quorum: number | null;
    conditionOperator: string | null;
    conditionValue: Prisma.InputJsonValue | null;
    isRequired: boolean;
    isFinalApprover: boolean;
    assigneeRole: { id: string } | null;
    assigneeUser: { id: string } | null;
  }> },
  applicableSteps: typeof policy.steps,
  conditionResults: Map<number, boolean>
): PolicySnapshot {
  const snapshotSteps = applicableSteps.map((step) => {
    const resolvedAssigneeIds: string[] = [];
    if (step.assigneeType === 'ROLE' && step.assigneeRoleId) {
      resolvedAssigneeIds.push(step.assigneeRoleId);
    } else if (step.assigneeType === 'USER' && step.assigneeUserId) {
      resolvedAssigneeIds.push(step.assigneeUserId);
    } else if (step.assigneeType === 'SPECIFIC_USER' && step.assigneeUserId) {
      resolvedAssigneeIds.push(step.assigneeUserId);
    }

    return {
      stepOrder: step.stepOrder,
      name: step.name,
      type: step.type as PolicySnapshot['steps'][0]['type'],
      assigneeType: step.assigneeType as PolicySnapshot['steps'][0]['assigneeType'],
      assigneeRoleId: step.assigneeRoleId,
      assigneeUserId: step.assigneeUserId,
      resolutionMode: step.resolutionMode as PolicySnapshot['steps'][0]['resolutionMode'],
      quorum: step.quorum,
      conditionOperator: step.conditionOperator as PolicySnapshot['steps'][0]['conditionOperator'],
      conditionValue: step.conditionValue as Prisma.InputJsonValue | null,
      isRequired: step.isRequired,
      isFinalApprover: step.isFinalApprover,
      resolvedAssigneeIds,
    };
  });

  return {
    policyId: policy.id,
    policyName: policy.name,
    entityType: policy.entityType,
    steps: snapshotSteps,
    createdAt: policy.createdAt,
  };
}

export async function getPolicySnapshot(
  policyId: string,
  context: ConditionContext,
  tx: Prisma.TransactionClient = prisma
): Promise<PolicySnapshot | null> {
  const policy = await tx.approvalPolicy.findUnique({
    where: { id: policyId },
    include: {
      steps: {
        include: {
          assigneeRole: true,
          assigneeUser: true,
        },
        orderBy: { stepOrder: 'asc' },
      },
    },
  });

  if (!policy) {
    return null;
  }

  const conditionResults = await evaluateConditions(
    policy.steps.map((s) => ({
      conditionOperator: s.conditionOperator,
      conditionValue: s.conditionValue as Prisma.InputJsonValue | null,
    })),
    context,
    tx
  );

  const applicableSteps = policy.steps.filter((step, index) => {
    const conditionMet = conditionResults.get(index) ?? false;
    return conditionMet;
  });

  return buildPolicySnapshot(policy, applicableSteps, conditionResults);
}