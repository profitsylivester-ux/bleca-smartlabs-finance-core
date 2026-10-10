import { NextResponse } from 'next/server';
import { z } from 'zod';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/kernel/errors';

const accountTypeSchema = z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']);
const normalBalanceSchema = z.enum(['DEBIT', 'CREDIT']);
const accountSubCategorySchema = z.enum([
  'CASH', 'BANK', 'MOBILE_MONEY', 'RECEIVABLE', 'INVENTORY', 'EQUIPMENT', 'OTHER_ASSET',
  'SUPPLIER_PAYABLE', 'TAX_PAYABLE', 'LOAN', 'ACCRUED_EXPENSE', 'OTHER_OBLIGATION',
  'CAPITAL', 'RETAINED_EARNINGS', 'FUTURE_INVESTMENT',
  'REVENUE_TRAINING', 'REVENUE_CONSULTING', 'REVENUE_SOFTWARE', 'REVENUE_SAAS',
  'REVENUE_AI_SERVICES', 'REVENUE_IOT_SERVICES', 'REVENUE_HARDWARE', 'REVENUE_ELECTRONICS',
  'REVENUE_COMPONENT_SALES', 'REVENUE_SUBSCRIPTION', 'REVENUE_TOKEN_PACKAGES', 'REVENUE_OTHER',
  'EXPENSE_INTERNET', 'EXPENSE_CLOUD', 'EXPENSE_AI_API', 'EXPENSE_TRANSPORT',
  'EXPENSE_MARKETING', 'EXPENSE_SOFTWARE', 'EXPENSE_WORKSPACE', 'EXPENSE_SALARIES',
  'EXPENSE_TRAINING', 'EXPENSE_HARDWARE_PROTOTYPING', 'EXPENSE_OTHER', 'CONTROL',
]);
const accountStatusSchema = z.enum(['ACTIVE', 'INACTIVE', 'LOCKED', 'PENDING_ARCHIVE']);

const updateSchema = z.object({
  code: z.string().min(2).max(50).toUpperCase().optional(),
  name: z.string().min(2).max(120).optional(),
  description: z.string().max(500).nullish(),
  type: accountTypeSchema.optional(),
  subCategory: accountSubCategorySchema.nullish().optional(),
  normalBalance: normalBalanceSchema.optional(),
  parentId: z.string().cuid().nullish().optional(),
  isPostable: z.boolean().optional(),
  isReconcilable: z.boolean().optional(),
  requiresDocument: z.boolean().optional(),
  status: accountStatusSchema.optional(),
});

const normalBalanceForType: Record<string, 'DEBIT' | 'CREDIT'> = {
  ASSET: 'DEBIT',
  LIABILITY: 'CREDIT',
  EQUITY: 'CREDIT',
  REVENUE: 'CREDIT',
  EXPENSE: 'DEBIT',
};

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

async function getAccountWithLines(id: string, orgId: string) {
  return prisma.account.findFirst({
    where: { id, organizationId: orgId },
    select: {
      id: true,
      code: true,
      name: true,
      type: true,
      subCategory: true,
      normalBalance: true,
      parentId: true,
      isPostable: true,
      isReconcilable: true,
      requiresDocument: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { journalLines: true, openingBalances: true, budgetLines: true } },
    },
  });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'MASTER_DATA', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const { id } = await params;
    const account = await getAccountWithLines(id, ctx.actor.organizationId);

    if (!account) {
      return apiError(new NotFoundError('Account', id), reqId);
    }

    return ok({ data: account }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'MASTER_DATA', action: 'EDIT' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const key = request.headers.get('idempotency-key');
    if (!key) {
      return apiError(
        new ValidationError('An Idempotency-Key header is required on this endpoint.'),
        reqId,
      );
    }

    const { id } = await params;
    const body = updateSchema.parse(await request.json());

    const existing = await getAccountWithLines(id, ctx.actor.organizationId);
    if (!existing) {
      return apiError(new NotFoundError('Account', id), reqId);
    }

    if (body.code && body.code !== existing.code) {
      const codeConflict = await prisma.account.findUnique({
        where: { organizationId_code: { organizationId: ctx.actor.organizationId, code: body.code } },
        select: { id: true },
      });
      if (codeConflict) {
        return apiError(new ConflictError('An account with this code already exists.'), reqId);
      }
    }

    if (body.parentId) {
      const parent = await prisma.account.findUnique({
        where: { id: body.parentId },
        select: { id: true, organizationId: true, type: true, normalBalance: true },
      });
      if (!parent || parent.organizationId !== ctx.actor.organizationId) {
        return apiError(new NotFoundError('Parent account', body.parentId), reqId);
      }
      const childType = body.type ?? existing.type;
      if (parent.type !== childType) {
        return apiError(
          new ValidationError('Parent account must be of the same type'),
          reqId,
        );
      }
    }

    if (body.normalBalance && body.type) {
      if (body.normalBalance !== normalBalanceForType[body.type]) {
        return apiError(
          new ValidationError(`Normal balance for ${body.type} must be ${normalBalanceForType[body.type]}`),
          reqId,
        );
      }
    } else if (body.normalBalance && !body.type) {
      if (body.normalBalance !== normalBalanceForType[existing.type]) {
        return apiError(
          new ValidationError(`Normal balance for ${existing.type} must be ${normalBalanceForType[existing.type]}`),
          reqId,
        );
      }
    } else if (body.type && !body.normalBalance) {
      if (existing.normalBalance !== normalBalanceForType[body.type]) {
        return apiError(
          new ValidationError(`Normal balance for ${body.type} must be ${normalBalanceForType[body.type]}`),
          reqId,
        );
      }
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `PATCH /api/v1/accounts/${id}`,
      actorId: ctx.actor.userId,
      body,
      handler: async () =>
        withAudit(
          {
            organizationId: ctx.actor.organizationId,
            actor: {
              id: ctx.actor.userId,
              name: ctx.actor.fullName,
              roleCodes: ctx.actor.roleCodes,
            },
            ipAddress: net.ipAddress,
            userAgent: net.userAgent,
            requestId: reqId,
            sessionId: ctx.actor.sessionId,
          },
          async (tx) => {
            const updated = await tx.account.update({
              where: { id },
              data: {
                ...(body.code && { code: body.code }),
                ...(body.name && { name: body.name }),
                ...(body.description !== undefined && { description: body.description }),
                ...(body.type && { type: body.type }),
                ...(body.subCategory !== undefined && { subCategory: body.subCategory }),
                ...(body.normalBalance && { normalBalance: body.normalBalance }),
                ...(body.parentId !== undefined && { parentId: body.parentId }),
                ...(body.isPostable !== undefined && { isPostable: body.isPostable }),
                ...(body.isReconcilable !== undefined && { isReconcilable: body.isReconcilable }),
                ...(body.requiresDocument !== undefined && { requiresDocument: body.requiresDocument }),
                ...(body.status !== undefined && { status: body.status }),
              },
              select: {
                id: true,
                code: true,
                name: true,
                type: true,
                subCategory: true,
                normalBalance: true,
                parentId: true,
                isPostable: true,
                isReconcilable: true,
                requiresDocument: true,
                status: true,
                createdAt: true,
                updatedAt: true,
              },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'ACCOUNT',
                entityId: updated.id,
                entityLabel: updated.code,
                description: `Updated account ${updated.code}`,
                changes: {
                  code: { from: existing.code, to: updated.code },
                  name: { from: existing.name, to: updated.name },
                  type: { from: existing.type, to: updated.type },
                  normalBalance: { from: existing.normalBalance, to: updated.normalBalance },
                  parentId: { from: existing.parentId, to: updated.parentId },
                  isPostable: { from: existing.isPostable, to: updated.isPostable },
                  isReconcilable: { from: existing.isReconcilable, to: updated.isReconcilable },
                  requiresDocument: { from: existing.requiresDocument, to: updated.requiresDocument },
                  status: { from: existing.status, to: updated.status },
                },
              },
              {
                organizationId: ctx.actor.organizationId,
                ipAddress: net.ipAddress,
                userAgent: net.userAgent,
                requestId: reqId,
                sessionId: ctx.actor.sessionId,
              },
            );

            return { status: 200, body: { data: updated } };
          },
        ),
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
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'MASTER_DATA', action: 'EDIT' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const { id } = await params;
    const existing = await getAccountWithLines(id, ctx.actor.organizationId);
    if (!existing) {
      return apiError(new NotFoundError('Account', id), reqId);
    }

    const hasLines = existing._count.journalLines > 0 || existing._count.openingBalances > 0 || existing._count.budgetLines > 0;
    if (hasLines) {
      const h = await headers();
      const net = await getAuditOptions(reqId, h);

      await withAudit(
        {
          organizationId: ctx.actor.organizationId,
          actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
          ipAddress: net.ipAddress,
          userAgent: net.userAgent,
          requestId: reqId,
          sessionId: ctx.actor.sessionId,
        },
        async (tx) => {
          await tx.account.update({
            where: { id },
            data: { status: 'LOCKED' },
          });

          await writeAuditEntry(
            tx,
            { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
            {
              action: 'CONFIGURATION_CHANGES',
              entityType: 'ACCOUNT',
              entityId: id,
              entityLabel: existing.code,
              description: `Locked account ${existing.code} (has associated lines)`,
              changes: { status: { from: existing.status, to: 'LOCKED' } },
            },
            {
              organizationId: ctx.actor.organizationId,
              ipAddress: net.ipAddress,
              userAgent: net.userAgent,
              requestId: reqId,
              sessionId: ctx.actor.sessionId,
            },
          );

          return { status: 200, body: { data: { id, locked: true } } };
        },
      );

      return ok({ data: { id, locked: true, message: 'Account has associated lines, locked instead of deleted' } }, 200, reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key: `delete-${id}-${Date.now()}`,
      scope: `DELETE /api/v1/accounts/${id}`,
      actorId: ctx.actor.userId,
      body: {},
      handler: async () =>
        withAudit(
          {
            organizationId: ctx.actor.organizationId,
            actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
            ipAddress: net.ipAddress,
            userAgent: net.userAgent,
            requestId: reqId,
            sessionId: ctx.actor.sessionId,
          },
          async (tx) => {
            await tx.account.delete({ where: { id } });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'ACCOUNT',
                entityId: id,
                entityLabel: existing.code,
                description: `Deleted account ${existing.code} (${existing.name})`,
                changes: {
                  code: { from: existing.code, to: null },
                  name: { from: existing.name, to: null },
                },
              },
              {
                organizationId: ctx.actor.organizationId,
                ipAddress: net.ipAddress,
                userAgent: net.userAgent,
                requestId: reqId,
                sessionId: ctx.actor.sessionId,
              },
            );

            return { status: 200, body: { data: { id, deleted: true } } };
          },
        ),
    });

    if (outcome.kind === 'REPLAYED') {
      return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    }

    return ok(outcome.result, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}