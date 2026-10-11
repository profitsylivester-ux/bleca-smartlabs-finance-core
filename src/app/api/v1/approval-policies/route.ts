import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { writeAuditEntry } from '@/lib/audit/writer';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';
import { Prisma } from '@/generated/prisma/client';

const createPolicySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  entityType: z.enum([
    'TRANSACTION', 'JOURNAL_ENTRY', 'INVOICE', 'PAYMENT', 'RECEIPT', 'QUOTATION',
    'CREDIT_NOTE', 'DEBIT_NOTE', 'REFUND', 'BUDGET', 'BUDGET_REVISION', 'BUDGET_TRANSFER',
    'COMMITMENT', 'PERIOD_REOPEN', 'FINANCIAL_CLOSE', 'ADJUSTMENT', 'REVERSAL',
    'MASTER_DATA_CHANGE', 'SUPPLIER_BANK_DETAIL_CHANGE', 'CUSTOMER_CREDIT_LIMIT',
    'DOCUMENT', 'IMPORT_BATCH', 'RECONCILIATION', 'RECONCILIATION_ADJUSTMENT', 'TAX_FILING'
  ]),
  isActive: z.boolean().default(true),
  priority: z.number().int().default(100),
  steps: z.array(z.object({
    stepOrder: z.number().int().positive(),
    name: z.string().min(1).max(200),
    type: z.enum(['APPROVAL', 'REVIEW', 'NOTIFICATION', 'SIGN_OFF']),
    assigneeType: z.enum(['ROLE', 'USER', 'USER_DELEGATED', 'SPECIFIC_USER']),
    assigneeRoleId: z.string().optional(),
    assigneeUserId: z.string().optional(),
    resolutionMode: z.enum(['ANY', 'ALL', 'QUORUM']).default('ANY'),
    quorum: z.number().int().positive().optional(),
    conditionOperator: z.enum([
      'ALWAYS', 'AMOUNT_GREATER_THAN', 'AMOUNT_GREATER_OR_EQUAL', 'AMOUNT_LESS_THAN',
      'AMOUNT_BETWEEN', 'PERCENT_OF_BUDGET', 'OVER_BUDGET', 'NEW_COUNTERPARTY',
      'SUPPLIER_BANK_DETAIL_CHANGED', 'FUNDING_RESTRICTED', 'CROSS_PROJECT',
      'CURRENCY_NOT_BASE', 'MANUAL_FLAG'
    ]).optional(),
    conditionValue: z.custom<Prisma.InputJsonValue | null>().optional(),
    isRequired: z.boolean().default(true),
    isFinalApprover: z.boolean().default(false),
  })).min(1),
});

const updatePolicySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  isActive: z.boolean().optional(),
  priority: z.number().int().optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ organizationId: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'APPROVALS', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') || '20', 10)));
    const entityType = searchParams.get('entityType') || undefined;
    const isActive = searchParams.get('isActive') ? searchParams.get('isActive') === 'true' : undefined;

    const where: Record<string, unknown> = { organizationId: ctx.actor.organizationId };
    if (entityType) where.entityType = entityType;
    if (isActive !== undefined) where.isActive = isActive;

    const [policies, total] = await Promise.all([
      prisma.approvalPolicy.findMany({
        where,
        orderBy: { priority: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          steps: {
            orderBy: { stepOrder: 'asc' },
            include: { assigneeRole: true, assigneeUser: true },
          },
        },
      }),
      prisma.approvalPolicy.count({ where }),
    ]);

    return ok({ data: policies, total, page, pageSize }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ organizationId: string }> },
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

    const body = createPolicySchema.parse(await request.json());
    const orgId = ctx.actor.organizationId!;

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/approval-policies`,
      actorId: ctx.actor.userId,
      body: await request.json(),
      handler: async (tx) => {
        const policy = await tx.approvalPolicy.create({
          data: {
            organizationId: orgId,
            name: body.name,
            description: body.description,
            entityType: body.entityType,
            isActive: body.isActive,
            priority: body.priority,
            createdById: ctx.actor.userId,
            steps: {
              create: body.steps.map((step) => ({
                stepOrder: step.stepOrder,
                name: step.name,
                type: step.type,
                assigneeType: step.assigneeType,
                assigneeRoleId: step.assigneeRoleId ?? null,
                assigneeUserId: step.assigneeUserId ?? null,
                resolutionMode: step.resolutionMode,
                quorum: step.quorum ?? null,
                conditionOperator: step.conditionOperator ?? null,
                conditionValue: step.conditionValue ?? Prisma.JsonNull,
                isRequired: step.isRequired,
                isFinalApprover: step.isFinalApprover,
              })),
            },
          },
          include: { steps: { include: { assigneeRole: true, assigneeUser: true }, orderBy: { stepOrder: 'asc' } } },
        }) as { id: string; name: string; entityType: string; steps: Array<{ id: string }>; createdAt: Date; updatedAt: Date; isActive: boolean; priority: number; organizationId: string; description: string | null; createdById: string | null; updatedById: string | null };

        await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, {
          action: 'APPROVAL_POLICY_CREATED',
          entityType: 'APPROVAL_POLICY',
          entityId: policy.id,
          entityLabel: policy.name,
          description: `Approval policy "${policy.name}" created`,
          metadata: { entityType: policy.entityType, stepsCount: policy.steps.length },
          result: 'SUCCESS',
          channel: 'WEB',
        }, { organizationId: orgId, requestId: reqId });

        return { status: 201, body: policy };
      },
    });

    if (outcome.kind === 'REPLAYED') {
      return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    }

    return ok(outcome.result, 201, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}