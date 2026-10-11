import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { writeAuditEntry } from '@/lib/audit/writer';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';

const updatePolicySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  isActive: z.boolean().optional(),
  priority: z.number().int().optional(),
});

const updateStepSchema = z.object({
  stepOrder: z.number().int().positive().optional(),
  name: z.string().min(1).max(200).optional(),
  type: z.enum(['APPROVAL', 'REVIEW', 'NOTIFICATION', 'SIGN_OFF']).optional(),
  assigneeType: z.enum(['ROLE', 'USER', 'USER_DELEGATED', 'SPECIFIC_USER']).optional(),
  assigneeRoleId: z.string().nullable().optional(),
  assigneeUserId: z.string().nullable().optional(),
  resolutionMode: z.enum(['ANY', 'ALL', 'QUORUM']).optional(),
  quorum: z.number().int().positive().nullable().optional(),
  conditionOperator: z.enum([
    'ALWAYS', 'AMOUNT_GREATER_THAN', 'AMOUNT_GREATER_OR_EQUAL', 'AMOUNT_LESS_THAN',
    'AMOUNT_BETWEEN', 'PERCENT_OF_BUDGET', 'OVER_BUDGET', 'NEW_COUNTERPARTY',
    'SUPPLIER_BANK_DETAIL_CHANGED', 'FUNDING_RESTRICTED', 'CROSS_PROJECT',
    'CURRENCY_NOT_BASE', 'MANUAL_FLAG'
  ]).nullable().optional(),
  conditionValue: z.unknown().nullable().optional(),
  isRequired: z.boolean().optional(),
  isFinalApprover: z.boolean().optional(),
});

const updateStepsSchema = z.object({
  steps: z.array(z.object({
    id: z.string().optional(),
    stepOrder: z.number().int().positive(),
    name: z.string().min(1).max(200),
    type: z.enum(['APPROVAL', 'REVIEW', 'NOTIFICATION', 'SIGN_OFF']),
    assigneeType: z.enum(['ROLE', 'USER', 'USER_DELEGATED', 'SPECIFIC_USER']),
    assigneeRoleId: z.string().nullable().optional(),
    assigneeUserId: z.string().nullable().optional(),
    resolutionMode: z.enum(['ANY', 'ALL', 'QUORUM']).default('ANY'),
    quorum: z.number().int().positive().nullable().optional(),
    conditionOperator: z.enum([
      'ALWAYS', 'AMOUNT_GREATER_THAN', 'AMOUNT_GREATER_OR_EQUAL', 'AMOUNT_LESS_THAN',
      'AMOUNT_BETWEEN', 'PERCENT_OF_BUDGET', 'OVER_BUDGET', 'NEW_COUNTERPARTY',
      'SUPPLIER_BANK_DETAIL_CHANGED', 'FUNDING_RESTRICTED', 'CROSS_PROJECT',
      'CURRENCY_NOT_BASE', 'MANUAL_FLAG'
    ]).nullable().optional(),
    conditionValue: z.unknown().nullable().optional(),
    isRequired: z.boolean().default(true),
    isFinalApprover: z.boolean().default(false),
  })).min(1),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ organizationId: string; id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'APPROVALS', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const { id } = await params;

    const policy = await prisma.approvalPolicy.findFirst({
      where: { id, organizationId: ctx.actor.organizationId },
      include: {
        steps: {
          orderBy: { stepOrder: 'asc' },
          include: { assigneeRole: true, assigneeUser: true },
        },
      },
    });

    if (!policy) {
      return apiError(new NotFoundError('ApprovalPolicy', id), reqId);
    }

    return ok(policy, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ organizationId: string; id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'APPROVALS', action: 'CONFIGURE' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const key = request.headers.get('idempotency-key');
    if (!key) {
      return apiError(new ValidationError('An Idempotency-Key header is required on this endpoint.'), reqId);
    }

    const { id } = await params;
    const orgId = ctx.actor.organizationId!;

    const existingPolicy = await prisma.approvalPolicy.findFirst({
      where: { id, organizationId: orgId },
      include: { steps: true },
    });

    if (!existingPolicy) {
      return apiError(new NotFoundError('ApprovalPolicy', id), reqId);
    }

    const body = updatePolicySchema.parse(await request.json());

    const outcome = await runIdempotent({
      key,
      scope: `PUT /api/v1/approval-policies/${id}`,
      actorId: ctx.actor.userId,
      body: await request.json(),
      handler: async (tx) => {
        const policy = await tx.approvalPolicy.update({
          where: { id },
          data: {
            name: body.name,
            description: body.description,
            isActive: body.isActive,
            priority: body.priority,
            updatedById: ctx.actor.userId,
          },
          include: { steps: { include: { assigneeRole: true, assigneeUser: true }, orderBy: { stepOrder: 'asc' } } },
        });

        await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, {
          action: 'APPROVAL_POLICY_UPDATED',
          entityType: 'APPROVAL_POLICY',
          entityId: policy.id,
          entityLabel: policy.name,
          description: `Approval policy "${policy.name}" updated`,
          changes: {
            name: { from: existingPolicy.name, to: policy.name },
            isActive: { from: existingPolicy.isActive, to: policy.isActive },
            priority: { from: existingPolicy.priority, to: policy.priority },
          },
          result: 'SUCCESS',
          channel: 'WEB',
        }, { organizationId: orgId, requestId: reqId });

        return { status: 200, body: policy };
      },
    });

    if (outcome.kind === 'REPLAYED') {
      return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    }

    return ok(outcome.result, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ organizationId: string; id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'APPROVALS', action: 'CONFIGURE' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const key = request.headers.get('idempotency-key');
    if (!key) {
      return apiError(new ValidationError('An Idempotency-Key header is required on this endpoint.'), reqId);
    }

    const { id } = await params;
    const orgId = ctx.actor.organizationId!;

    const existingPolicy = await prisma.approvalPolicy.findFirst({
      where: { id, organizationId: orgId },
    });

    if (!existingPolicy) {
      return apiError(new NotFoundError('ApprovalPolicy', id), reqId);
    }

    const inFlightRequests = await prisma.approvalRequest.count({
      where: { policyId: id, status: { in: ['PENDING', 'IN_PROGRESS'] } },
    });

    if (inFlightRequests > 0) {
      return apiError(new ValidationError(`Cannot delete policy with ${inFlightRequests} in-flight requests`), reqId);
    }

    const outcome = await runIdempotent({
      key,
      scope: `DELETE /api/v1/approval-policies/${id}`,
      actorId: ctx.actor.userId,
      body: {},
      handler: async (tx) => {
        await tx.approvalPolicyStep.deleteMany({ where: { policyId: id } });
        await tx.approvalPolicy.delete({ where: { id } });

        await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, {
          action: 'APPROVAL_POLICY_DELETED',
          entityType: 'APPROVAL_POLICY',
          entityId: id,
          entityLabel: existingPolicy.name,
          description: `Approval policy "${existingPolicy.name}" deleted`,
          result: 'SUCCESS',
          channel: 'WEB',
        }, { organizationId: orgId, requestId: reqId });

        return { status: 204, body: null };
      },
    });

    if (outcome.kind === 'REPLAYED') {
      return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    }

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiError(error, reqId);
  }
}