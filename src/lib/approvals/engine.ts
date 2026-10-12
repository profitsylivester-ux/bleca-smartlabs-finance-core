import { prisma } from '@/lib/db/prisma';
import type {
  ApprovalRequest,
  ApprovalStepInstance,
  ApprovalDecisionRecord,
  PolicySnapshot,
  PolicySnapshotStep,
  ApprovalEntityType,
  ApprovalDecision,
  ApprovalRequestStatus,
  ApprovalAssigneeType,
  ResolutionMode,
  AdvanceRequestResult,
  ConditionContext,
} from './types';
import { resolveApprovers, DelegationResolver } from './approver-resolver';
import { writeAuditEntry } from '@/lib/audit/writer';
import { Prisma } from '@/generated/prisma/client';

const DEFAULT_DELEGATION_RESOLVER: DelegationResolver = async () => null;

export async function advanceRequest(
  requestId: string,
  decision: ApprovalDecision,
  actor: { userId: string; fullName: string; roleCodes: string[] },
  options: {
    reason?: string;
    delegationResolver?: DelegationResolver;
    tx?: Prisma.TransactionClient;
  } = {}
): Promise<AdvanceRequestResult> {
  const { reason, delegationResolver = DEFAULT_DELEGATION_RESOLVER, tx = prisma } = options;

  const request = await tx.approvalRequest.findUnique({
    where: { id: requestId },
    include: {
      stepInstances: {
        orderBy: { stepOrder: 'asc' },
      },
    },
  });

  if (!request) {
    throw new Error(`Approval request ${requestId} not found`);
  }

  if (request.status !== 'PENDING' && request.status !== 'IN_PROGRESS') {
    throw new Error(`Cannot advance request in ${request.status} status`);
  }

  const currentStepIndex = request.currentStepIndex;
  const currentStepInstance = request.stepInstances[currentStepIndex];

  if (!currentStepInstance) {
    throw new Error(`No step instance at index ${currentStepIndex}`);
  }

  if (currentStepInstance.status !== 'PENDING') {
    throw new Error(`Step ${currentStepIndex} already decided`);
  }

  const policySnapshot = request.policySnapshot as unknown as PolicySnapshot;
  const stepSnapshot = policySnapshot.steps[currentStepIndex];

  if (!stepSnapshot) {
    throw new Error(`No step snapshot at index ${currentStepIndex}`);
  }

  const resolution = await resolveApprovers(
    stepSnapshot,
    {
      id: request.id,
      entityType: request.entityType,
      entityId: request.entityId,
      submittedById: request.submittedById,
      amount: 0,
      currencyCode: 'TZS',
      organizationId: request.organizationId,
    },
    delegationResolver
  );

  const isActorAuthorized = resolution.resolvedAssigneeIds.includes(actor.userId);
  const isSelfApprovalAttempt = actor.userId === request.submittedById;

  if (!isActorAuthorized && decision !== 'SKIPPED') {
    if (isSelfApprovalAttempt) {
      await tx.approvalDecisionRecord.create({
        data: {
          requestId: request.id,
          stepInstanceId: currentStepInstance.id,
          actorId: actor.userId,
          decision: 'REJECTED',
          reason: 'Self-approval attempt blocked: SOD violation',
          sodViolation: true,
          sodWaiverId: null,
          delegationId: null,
        },
      });

      await writeAuditEntry(
        tx,
        { id: actor.userId, name: actor.fullName, roleCodes: actor.roleCodes },
        {
          action: 'APPROVAL_STEP_DECIDED',
          entityType: 'APPROVAL_STEP_INSTANCE',
          entityId: request.id,
          entityLabel: currentStepInstance.stepName,
          description: `Self-approval attempt blocked for step "${currentStepInstance.stepName}" on request ${request.id}`,
          changes: {
            stepStatus: { from: 'PENDING', to: 'REJECTED' },
            requestStatus: { from: request.status, to: request.status },
          },
          metadata: {
            decision: 'REJECTED',
            reason: 'Self-approval attempt blocked: SOD violation',
            sodViolation: true,
            sodWaiverId: null,
            delegationId: null,
            actorRoleCodes: actor.roleCodes,
            stepInstanceId: currentStepInstance.id,
          },
          result: 'FAILURE',
          channel: 'WEB',
        },
        { organizationId: request.organizationId, requestId: request.id }
      );
    }
    throw new Error(`User ${actor.userId} is not authorized to decide on this step`);
  }

  const decisionRecord = await tx.approvalDecisionRecord.create({
    data: {
      requestId: request.id,
      stepInstanceId: currentStepInstance.id,
      actorId: actor.userId,
      decision,
      reason: reason ?? null,
      sodViolation: resolution.sodViolation,
      sodWaiverId: resolution.sodWaiverId,
      delegationId: resolution.delegationId,
    },
  });

  await tx.approvalStepInstance.update({
    where: { id: currentStepInstance.id },
    data: {
      status: mapDecisionToStatus(decision),
      decidedAt: new Date(),
      decidedById: actor.userId,
    },
  });

  const { isComplete, nextStepInstance, updatedRequest } = await advanceWorkflow(
    tx,
    request,
    currentStepIndex,
    decision,
    decisionRecord,
    actor
  );

  if (decision === 'REJECTED' || decision === 'CANCELLED') {
    await updateBusinessDocumentDecision(tx, request, decision);
  }
  if (request.entityType === 'DOCUMENT' && updatedRequest.status === 'APPROVED') {
    await tx.document.update({
      where: { id: request.entityId },
      data: { status: 'APPROVED', approvedById: actor.userId, approvedAt: new Date() },
    });
  }

  await writeAuditEntry(
    tx,
    { id: actor.userId, name: actor.fullName, roleCodes: actor.roleCodes },
    {
      action: 'APPROVAL_STEP_DECIDED',
      entityType: 'APPROVAL_STEP_INSTANCE',
      entityId: request.id,
      entityLabel: currentStepInstance.stepName,
      description: `Step "${currentStepInstance.stepName}" ${decision.toLowerCase()} for request ${request.id}`,
      changes: {
        stepStatus: { from: 'PENDING', to: mapDecisionToStatus(decision) },
        requestStatus: { from: request.status, to: updatedRequest.status },
      },
      metadata: {
        decision,
        reason: reason ?? null,
        sodViolation: resolution.sodViolation,
        sodWaiverId: resolution.sodWaiverId,
        delegationId: resolution.delegationId,
        actorRoleCodes: actor.roleCodes,
        stepInstanceId: currentStepInstance.id,
      },
      result: 'SUCCESS',
      channel: 'WEB',
    },
    { organizationId: request.organizationId, requestId: request.id }
  );

  return {
    request: updatedRequest,
    stepInstance: currentStepInstance,
    decisionRecord,
    isComplete,
    nextStepInstance,
  };
}

async function advanceWorkflow(
  tx: Prisma.TransactionClient,
  request: ApprovalRequest & { stepInstances: ApprovalStepInstance[] },
  currentStepIndex: number,
  decision: ApprovalDecision,
  decisionRecord: ApprovalDecisionRecord,
  actor: { userId: string; fullName: string; roleCodes: string[] }
): Promise<{
  isComplete: boolean;
  nextStepInstance: ApprovalStepInstance | null;
  updatedRequest: ApprovalRequest;
}> {
  const policySnapshot = request.policySnapshot as unknown as PolicySnapshot;
  const totalSteps = policySnapshot.steps.length;

  if (decision === 'REJECTED' || decision === 'CANCELLED') {
    const updatedRequest = await tx.approvalRequest.update({
      where: { id: request.id },
      data: {
        status: decision === 'REJECTED' ? 'REJECTED' : 'CANCELLED',
        decidedAt: new Date(),
        decidedById: actor.userId,
        currentStepIndex: totalSteps,
      },
    });

    return {
      isComplete: true,
      nextStepInstance: null,
      updatedRequest,
    };
  }

  if (decision === 'SKIPPED') {
    const nextStepIndex = currentStepIndex + 1;
    if (nextStepIndex >= totalSteps) {
      return completeRequest(tx, request, actor);
    }

    const nextStepInstance = await tx.approvalStepInstance.findFirst({
      where: { requestId: request.id, stepOrder: nextStepIndex + 1 },
    });

    if (!nextStepInstance) {
      return completeRequest(tx, request, actor);
    }

    const nextStepSnapshot = policySnapshot.steps[nextStepIndex];
    if (!nextStepSnapshot) {
      return completeRequest(tx, request, actor);
    }

    await resolveNextStepApprovers(tx, nextStepInstance, request, nextStepSnapshot);

    await tx.approvalRequest.update({
      where: { id: request.id },
      data: { currentStepIndex: nextStepIndex, status: 'IN_PROGRESS' },
    });

    await tx.approvalStepInstance.update({
      where: { id: nextStepInstance.id },
      data: { status: 'PENDING' },
    });

    const updatedRequest = await tx.approvalRequest.findUniqueOrThrow({ where: { id: request.id } });

    return { isComplete: false, nextStepInstance, updatedRequest };
  }

  if (decision === 'DEFERRED' || decision === 'RETURNED_FOR_CHANGES') {
    const updatedRequest = await tx.approvalRequest.update({
      where: { id: request.id },
      data: {
        status: 'PENDING',
      },
    });

    return {
      isComplete: false,
      nextStepInstance: null,
      updatedRequest,
    };
  }

  const currentStepSnapshot = policySnapshot.steps[currentStepIndex];
  if (currentStepSnapshot?.isFinalApprover) {
    return completeRequest(tx, request, actor);
  }

  const nextStepIndex = currentStepIndex + 1;
  if (nextStepIndex >= totalSteps) {
    return completeRequest(tx, request, actor);
  }

  const nextStepInstance = await tx.approvalStepInstance.findFirst({
    where: { requestId: request.id, stepOrder: nextStepIndex + 1 },
  });

  if (!nextStepInstance) {
    return completeRequest(tx, request, actor);
  }

  const nextStepSnapshot = policySnapshot.steps[nextStepIndex];
  if (!nextStepSnapshot) {
    return completeRequest(tx, request, actor);
  }

  await resolveNextStepApprovers(tx, nextStepInstance, request, nextStepSnapshot);

  const updatedRequest = await tx.approvalRequest.update({
    where: { id: request.id },
    data: { currentStepIndex: nextStepIndex, status: 'IN_PROGRESS' },
  });

  await tx.approvalStepInstance.update({
    where: { id: nextStepInstance.id },
    data: { status: 'PENDING' },
  });

  return { isComplete: false, nextStepInstance, updatedRequest };
}

async function completeRequest(
  tx: Prisma.TransactionClient,
  request: ApprovalRequest,
  actor: { userId: string; fullName: string; roleCodes: string[] }
) {
  const updatedRequest = await tx.approvalRequest.update({
    where: { id: request.id },
    data: {
      status: 'APPROVED',
      decidedAt: new Date(),
      decidedById: actor.userId,
      currentStepIndex: (request.policySnapshot as unknown as PolicySnapshot).steps.length,
    },
  });

  if (request.entityType === 'TRANSACTION') {
    await tx.transaction.update({
      where: { id: request.entityId },
      data: { status: 'APPROVED' },
    });
  }

  if (request.entityType === 'QUOTATION') {
    await tx.quotation.update({
      where: { id: request.entityId },
      data: { status: 'APPROVED', approvedById: actor.userId, approvedAt: new Date() },
    });
  }
  if (request.entityType === 'INVOICE') {
    await tx.invoice.update({
      where: { id: request.entityId },
      data: { status: 'APPROVED', approvedById: actor.userId, approvedAt: new Date() },
    });
  }
  if (request.entityType === 'PAYMENT') {
    await tx.payment.update({
      where: { id: request.entityId },
      data: { status: 'APPROVED', approvedById: actor.userId, approvedAt: new Date() },
    });
  }
  if (request.entityType === 'CREDIT_NOTE') {
    await tx.creditNote.update({
      where: { id: request.entityId },
      data: { status: 'APPROVED', approvedById: actor.userId, approvedAt: new Date() },
    });
  }
  if (request.entityType === 'DEBIT_NOTE') {
    await tx.debitNote.update({
      where: { id: request.entityId },
      data: { status: 'APPROVED', approvedById: actor.userId, approvedAt: new Date() },
    });
  }

  await writeAuditEntry(
    tx,
    { id: actor.userId, name: actor.fullName, roleCodes: actor.roleCodes },
    {
      action: 'APPROVAL_REQUEST_APPROVED',
      entityType: 'APPROVAL_REQUEST',
      entityId: request.id,
      entityLabel: request.id,
      description: `Approval request ${request.id} fully approved`,
      changes: { status: { from: request.status, to: 'APPROVED' } },
      metadata: { actorRoleCodes: actor.roleCodes },
      result: 'SUCCESS',
      channel: 'WEB',
    },
    { organizationId: request.organizationId, requestId: request.id }
  );

  return { isComplete: true, nextStepInstance: null as ApprovalStepInstance | null, updatedRequest };
}

async function updateBusinessDocumentDecision(
  tx: Prisma.TransactionClient,
  request: ApprovalRequest,
  decision: 'REJECTED' | 'CANCELLED',
): Promise<void> {
  const status = decision === 'REJECTED' ? 'REJECTED' : 'CANCELLED';
  if (request.entityType === 'DOCUMENT') {
    await tx.document.update({
      where: { id: request.entityId },
      data: {
        status: decision === 'REJECTED' ? 'REJECTED' : 'AVAILABLE',
        ...(decision === 'CANCELLED' ? { approvalRequestId: null } : {}),
      },
    });
    return;
  }
  if (request.entityType === 'QUOTATION') {
    await tx.quotation.update({ where: { id: request.entityId }, data: { status } });
  }
  if (request.entityType === 'INVOICE') {
    await tx.invoice.update({ where: { id: request.entityId }, data: { status } });
  }
  if (request.entityType === 'PAYMENT') {
    await tx.payment.update({ where: { id: request.entityId }, data: { status } });
  }
  if (request.entityType === 'CREDIT_NOTE') {
    await tx.creditNote.update({ where: { id: request.entityId }, data: { status } });
  }
  if (request.entityType === 'DEBIT_NOTE') {
    await tx.debitNote.update({ where: { id: request.entityId }, data: { status } });
  }
}

async function resolveNextStepApprovers(
  tx: Prisma.TransactionClient,
  stepInstance: ApprovalStepInstance,
  request: ApprovalRequest,
  stepSnapshot: PolicySnapshotStep
): Promise<void> {
  if (stepSnapshot.assigneeType === 'ROLE' && stepSnapshot.assigneeRoleId) {
    const roleUsers = await tx.user.findMany({
      where: {
        userRoles: {
          some: {
            roleId: stepSnapshot.assigneeRoleId,
            revokedAt: null,
            OR: [
              { expiresAt: null },
              { expiresAt: { gt: new Date() } },
            ],
          },
        },
        organizationMemberships: {
          some: { organizationId: request.organizationId },
        },
        isActive: true,
        status: 'ACTIVE',
      },
      select: { id: true },
    });

    const userIds = roleUsers.map((u) => u.id);

    await tx.approvalStepInstance.update({
      where: { id: stepInstance.id },
      data: {
        assigneeType: 'ROLE',
        assigneeRoleId: stepSnapshot.assigneeRoleId,
        assigneeUserId: userIds.length === 1 ? userIds[0] : null,
      },
    });
  }
}

function mapDecisionToStatus(decision: ApprovalDecision): ApprovalRequestStatus {
  switch (decision) {
    case 'APPROVED':
      return 'APPROVED';
    case 'REJECTED':
      return 'REJECTED';
    case 'SKIPPED':
      return 'APPROVED';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'DEFERRED':
      return 'PENDING';
    case 'RETURNED_FOR_CHANGES':
      return 'PENDING';
    default:
      return 'PENDING';
  }
}

export async function createApprovalRequest(
  input: {
    organizationId: string;
    entityType: ApprovalEntityType;
    entityId: string;
    amount: number;
    currencyCode: string;
    submittedById: string;
    context: ConditionContext;
  },
  tx: Prisma.TransactionClient = prisma
): Promise<ApprovalRequest> {
  const { selectPolicy } = await import('./policy-selector');
  const { policy, snapshot } = await selectPolicy(input.entityType, input.amount, input.context, tx);

  const stepInstancesData = snapshot.steps.map((step) => ({
    stepOrder: step.stepOrder,
    stepName: step.name,
    stepType: step.type,
    assigneeType: step.assigneeType,
    assigneeRoleId: step.assigneeRoleId,
    assigneeUserId: step.assigneeUserId,
    resolutionMode: step.resolutionMode,
    quorum: step.quorum,
    status: 'PENDING' as ApprovalRequestStatus,
  }));

  const request = await tx.approvalRequest.create({
    data: {
      organizationId: input.organizationId,
      entityType: input.entityType,
      entityId: input.entityId,
      policyId: policy.id,
      policySnapshot: snapshot as unknown as Prisma.InputJsonObject,
      submittedById: input.submittedById,
      status: 'IN_PROGRESS',
      currentStepIndex: 0,
      stepInstances: {
        create: stepInstancesData,
      },
    },
    include: { stepInstances: true },
  });

  if (request.stepInstances.length > 0 && snapshot.steps.length > 0) {
    const firstStep = request.stepInstances[0]!;
    const firstSnapshotStep = snapshot.steps[0]!;
    await resolveNextStepApprovers(tx, firstStep, request, firstSnapshotStep);
  }

  await writeAuditEntry(
    tx,
    { id: input.submittedById, name: '', roleCodes: [] },
    {
      action: 'APPROVAL_REQUEST_CREATED',
      entityType: 'APPROVAL_REQUEST',
      entityId: request.id,
      entityLabel: request.id,
      description: `Approval request created for ${input.entityType} ${input.entityId}`,
      metadata: { policyId: policy.id, policyName: policy.name, entityType: input.entityType, amount: input.amount },
      result: 'SUCCESS',
      channel: 'WEB',
    },
    { organizationId: input.organizationId, requestId: request.id }
  );

  return request;
}

export async function cancelApprovalRequest(
  requestId: string,
  actor: { userId: string; fullName: string; roleCodes: string[] },
  reason?: string,
  tx: Prisma.TransactionClient = prisma
): Promise<ApprovalRequest> {
  const request = await tx.approvalRequest.findUnique({
    where: { id: requestId },
    include: { stepInstances: true },
  });

  if (!request) {
    throw new Error(`Approval request ${requestId} not found`);
  }

  if (request.status === 'APPROVED' || request.status === 'REJECTED' || request.status === 'CANCELLED') {
    throw new Error(`Cannot cancel request in ${request.status} status`);
  }

  if (request.submittedById !== actor.userId && !actor.roleCodes.includes('CEO')) {
    throw new Error('Only the submitter or CEO can cancel this request');
  }

  const updatedRequest = await tx.approvalRequest.update({
    where: { id: requestId },
    data: {
      status: 'CANCELLED',
      decidedAt: new Date(),
      decidedById: actor.userId,
    },
  });

  await tx.approvalStepInstance.updateMany({
    where: { requestId, status: 'PENDING' },
    data: { status: 'CANCELLED', decidedAt: new Date(), decidedById: actor.userId },
  });

  await writeAuditEntry(
    tx,
    { id: actor.userId, name: actor.fullName, roleCodes: actor.roleCodes },
    {
      action: 'APPROVAL_REQUEST_CANCELLED',
      entityType: 'APPROVAL_REQUEST',
      entityId: request.id,
      entityLabel: request.id,
      description: `Approval request ${request.id} cancelled`,
      changes: { status: { from: request.status, to: 'CANCELLED' } },
      metadata: { reason: reason ?? null, actorRoleCodes: actor.roleCodes },
      result: 'SUCCESS',
      channel: 'WEB',
    },
    { organizationId: request.organizationId, requestId: request.id }
  );

  return updatedRequest;
}
