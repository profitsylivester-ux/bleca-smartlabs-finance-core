import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { writeAuditEntry } from '@/lib/audit/writer';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';
import { createApprovalRequest } from '@/lib/approvals';
import type { ConditionContext } from '@/lib/approvals';
import { Prisma } from '@/generated/prisma/client';

const createApprovalSchema = z.object({
  entityType: z.enum([
    'TRANSACTION', 'JOURNAL_ENTRY', 'INVOICE', 'PAYMENT', 'RECEIPT', 'QUOTATION',
    'CREDIT_NOTE', 'DEBIT_NOTE', 'REFUND', 'BUDGET', 'BUDGET_REVISION', 'BUDGET_TRANSFER',
    'COMMITMENT', 'PERIOD_REOPEN', 'FINANCIAL_CLOSE', 'ADJUSTMENT', 'REVERSAL',
    'MASTER_DATA_CHANGE', 'SUPPLIER_BANK_DETAIL_CHANGE', 'CUSTOMER_CREDIT_LIMIT',
    'DOCUMENT', 'IMPORT_BATCH', 'RECONCILIATION', 'RECONCILIATION_ADJUSTMENT', 'TAX_FILING'
  ]),
  entityId: z.string(),
  amount: z.number().positive(),
  currencyCode: z.string().length(3),
  context: z.object({
    projectId: z.string().optional(),
    departmentId: z.string().optional(),
    costCentreId: z.string().optional(),
    fundingSourceId: z.string().optional(),
    accountId: z.string().optional(),
    counterpartyId: z.string().optional(),
    counterpartyBankDetailsChanged: z.boolean().optional(),
  }).optional(),
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
    const status = searchParams.get('status') || undefined;
    const entityType = searchParams.get('entityType') || undefined;
    const submittedByMe = searchParams.get('submittedByMe') === 'true';
    const assignedToMe = searchParams.get('assignedToMe') === 'true';

    const where: Record<string, unknown> = { organizationId: ctx.actor.organizationId };
    if (status) where.status = status;
    if (entityType) where.entityType = entityType;
    if (submittedByMe) where.submittedById = ctx.actor.userId;

    let requests;
    let total;

    if (assignedToMe) {
      const stepInstances = await prisma.approvalStepInstance.findMany({
        where: {
          request: { organizationId: ctx.actor.organizationId },
          OR: [
            { assigneeUserId: ctx.actor.userId },
            {
              assigneeRole: {
                userRoles: {
                  some: { userId: ctx.actor.userId, revokedAt: null },
                },
              },
            },
          ],
          status: 'PENDING',
        },
        include: { request: true },
        distinct: ['requestId'],
      });

      const requestIds = stepInstances.map((si) => si.requestId);
      where.id = { in: requestIds };

      [requests, total] = await Promise.all([
        prisma.approvalRequest.findMany({
          where,
          orderBy: { submittedAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: {
            stepInstances: { orderBy: { stepOrder: 'asc' } },
            policy: true,
          },
        }),
        prisma.approvalRequest.count({ where }),
      ]);
    } else {
      [requests, total] = await Promise.all([
        prisma.approvalRequest.findMany({
          where,
          orderBy: { submittedAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: {
            stepInstances: { orderBy: { stepOrder: 'asc' } },
            policy: true,
          },
        }),
        prisma.approvalRequest.count({ where }),
      ]);
    }

    return ok({ data: requests, total, page, pageSize }, 200, reqId);
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
    await authorize(ctx, { module: 'APPROVALS', action: 'SUBMIT' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const key = request.headers.get('idempotency-key');
    if (!key) {
      return apiError(new ValidationError('An Idempotency-Key header is required on this endpoint.'), reqId);
    }

    const orgId = ctx.actor.organizationId!;
    const body = createApprovalSchema.parse(await request.json());

    const context: ConditionContext = {
      organizationId: orgId,
      entityType: body.entityType,
      entityId: body.entityId,
      submittedById: ctx.actor.userId,
      amount: body.amount,
      currencyCode: body.currencyCode,
      projectId: body.context?.projectId ?? null,
      departmentId: body.context?.departmentId ?? null,
      costCentreId: body.context?.costCentreId ?? null,
      fundingSourceId: body.context?.fundingSourceId ?? null,
      accountId: body.context?.accountId ?? null,
      counterpartyId: body.context?.counterpartyId ?? null,
      counterpartyBankDetailsChanged: body.context?.counterpartyBankDetailsChanged ?? false,
    };

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/approvals`,
      actorId: ctx.actor.userId,
      body: await request.json(),
      handler: async (tx) => {
        const request = await createApprovalRequest(
          {
            organizationId: orgId,
            entityType: body.entityType,
            entityId: body.entityId,
            amount: body.amount,
            currencyCode: body.currencyCode,
            submittedById: ctx.actor.userId,
            context,
          },
          tx
        );

        await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, {
          action: 'APPROVAL_REQUEST_SUBMITTED',
          entityType: 'APPROVAL_REQUEST',
          entityId: request.id,
          entityLabel: request.id,
          description: `Approval request submitted for ${body.entityType} ${body.entityId}`,
          metadata: { entityType: body.entityType, entityId: body.entityId, amount: body.amount, policyId: request.policyId },
          result: 'SUCCESS',
          channel: 'WEB',
        }, { organizationId: orgId, requestId: reqId });

        return { status: 201, body: request };
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