import { prisma } from '@/lib/db/prisma';
import type {
  ApproverResolutionResult,
  PolicySnapshotStep,
  ApprovalEntityType,
  ApprovalAssigneeType,
  DelegationScope,
} from './types';
import { Prisma } from '@/generated/prisma/client';

export interface DelegationResolver {
  (userId: string, entityType: ApprovalEntityType, amount: number, scope: DelegationScope): Promise<string | null>;
}

export async function resolveApprovers(
  step: PolicySnapshotStep,
  request: {
    id: string;
    entityType: ApprovalEntityType;
    entityId: string;
    submittedById: string;
    amount: number;
    currencyCode: string;
    organizationId: string;
  },
  delegationResolver: DelegationResolver
): Promise<ApproverResolutionResult> {
  let assigneeType = step.assigneeType;
  const assigneeRoleId = step.assigneeRoleId;
  let assigneeUserId = step.assigneeUserId;
  let resolvedAssigneeIds: string[] = [];
  let delegationId: string | null = null;
  let sodViolation = false;
  let sodWaiverId: string | null = null;

  if (assigneeType === 'ROLE' && assigneeRoleId) {
    const roleUsers = await getUsersWithRole(assigneeRoleId, request.organizationId);
    resolvedAssigneeIds = roleUsers.map((u) => u.id);

    for (const userId of resolvedAssigneeIds) {
      const delegation = await findActiveDelegation(userId, request.entityType, request.amount, {
        maxAmount: request.amount,
        currency: request.currencyCode,
        entityTypes: [request.entityType],
      });

      if (delegation) {
        delegationId = delegation.id;
        assigneeType = 'USER_DELEGATED';
        assigneeUserId = delegation.granteeId;
        resolvedAssigneeIds = [delegation.granteeId];
        break;
      }
    }
  } else if (assigneeType === 'USER' && assigneeUserId) {
    resolvedAssigneeIds = [assigneeUserId];

    const delegation = await findActiveDelegation(assigneeUserId, request.entityType, request.amount, {
      maxAmount: request.amount,
      currency: request.currencyCode,
      entityTypes: [request.entityType],
    });

    if (delegation) {
      delegationId = delegation.id;
      assigneeType = 'USER_DELEGATED';
      assigneeUserId = delegation.granteeId;
      resolvedAssigneeIds = [delegation.granteeId];
    }
  } else if (assigneeType === 'SPECIFIC_USER' && assigneeUserId) {
    resolvedAssigneeIds = [assigneeUserId];

    const delegation = await findActiveDelegation(assigneeUserId, request.entityType, request.amount, {
      maxAmount: request.amount,
      currency: request.currencyCode,
      entityTypes: [request.entityType],
    });

    if (delegation) {
      delegationId = delegation.id;
      assigneeType = 'USER_DELEGATED';
      assigneeUserId = delegation.granteeId;
      resolvedAssigneeIds = [delegation.granteeId];
    }
  }

  if (resolvedAssigneeIds.length === 0) {
    throw new Error('No eligible approvers found for this step');
  }

  const primaryApproverId = resolvedAssigneeIds[0]!;
  const sodCheck = await checkSodViolation(primaryApproverId, request);
  if (sodCheck.isViolation) {
    sodViolation = true;
    sodWaiverId = sodCheck.waiverId;
  }

  return {
    assigneeType,
    assigneeRoleId,
    assigneeUserId,
    resolvedAssigneeIds,
    delegationId,
    sodViolation,
    sodWaiverId,
  };
}

async function getUsersWithRole(roleId: string, organizationId: string) {
  const usersWithDelegation = await prisma.delegation.findMany({
    where: {
      roleId,
      kind: 'APPROVAL_AUTHORITY',
      revokedAt: null,
    },
    select: { granteeId: true },
  });
  const granteeIds = new Set(usersWithDelegation.map(d => d.granteeId));

  const roleUsers = await prisma.user.findMany({
    where: {
      userRoles: {
        some: {
          roleId,
          revokedAt: null,
          OR: [
            { expiresAt: null },
            { expiresAt: { gt: new Date() } },
          ],
        },
      },
      organizationMemberships: {
        some: { organizationId },
      },
      isActive: true,
      status: 'ACTIVE',
      id: { notIn: Array.from(granteeIds) },
    },
    select: { id: true },
  });

  return roleUsers;
}

async function findActiveDelegation(
  grantorId: string,
  entityType: ApprovalEntityType,
  amount: number,
  scope: DelegationScope
) {
  const now = new Date();
  const delegations = await prisma.delegation.findMany({
    where: {
      grantorId,
      kind: 'APPROVAL_AUTHORITY',
      revokedAt: null,
      startsAt: { lte: now },
      expiresAt: { gt: now },
    },
    include: {
      grantee: {
        select: { id: true, isActive: true, status: true },
      },
    },
  });

  for (const delegation of delegations) {
    if (!delegation.grantee.isActive || delegation.grantee.status !== 'ACTIVE') {
      continue;
    }

    const delegationScope = delegation.scope as DelegationScope | null;
    if (delegationScope) {
      if (delegationScope.maxAmount !== undefined && amount > delegationScope.maxAmount) {
        continue;
      }
      if (delegationScope.currency && delegationScope.currency !== scope.currency) {
        continue;
      }
      if (delegationScope.entityTypes && !delegationScope.entityTypes.includes(entityType)) {
        continue;
      }
      if (delegationScope.dimensionLimits) {
        const dimOk = Object.entries(delegationScope.dimensionLimits).every(([dim, values]) => {
          const scopeValues = scope.dimensionLimits?.[dim];
          return !scopeValues || values.some((v) => scopeValues.includes(v));
        });
        if (!dimOk) continue;
      }
    }

    return delegation;
  }

  return null;
}

async function checkSodViolation(
  approverId: string,
  request: {
    id: string;
    entityType: ApprovalEntityType;
    entityId: string;
    submittedById: string;
    organizationId: string;
  }
): Promise<{ isViolation: boolean; waiverId: string | null }> {
  if (approverId === request.submittedById) {
    return { isViolation: true, waiverId: null };
  }

  const existingWaiver = await prisma.sODWaiver.findFirst({
    where: {
      userId: approverId,
      transactionId: request.entityId,
      approvalRequestId: request.id,
      status: 'GRANTED',
    },
    select: { id: true },
  });

  if (existingWaiver) {
    return { isViolation: false, waiverId: existingWaiver.id };
  }

  return { isViolation: false, waiverId: null };
}