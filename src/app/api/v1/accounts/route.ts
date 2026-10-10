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

const createSchema = z.object({
  code: z.string().min(2).max(50).toUpperCase(),
  name: z.string().min(2).max(120),
  description: z.string().max(500).nullish(),
  type: accountTypeSchema,
  subCategory: accountSubCategorySchema.nullish(),
  normalBalance: normalBalanceSchema,
  parentId: z.string().cuid().nullish(),
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

interface AccountNode {
  id: string;
  code: string;
  name: string;
  type: string;
  subCategory: string | null;
  normalBalance: string;
  parentId: string | null;
  isPostable: boolean;
  isReconcilable: boolean;
  requiresDocument: boolean;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  children: AccountNode[];
}

function buildHierarchicalList(accounts: Array<{
  id: string;
  code: string;
  name: string;
  type: string;
  subCategory: string | null;
  normalBalance: string;
  parentId: string | null;
  isPostable: boolean;
  isReconcilable: boolean;
  requiresDocument: boolean;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}>): AccountNode[] {
  const map = new Map<string, AccountNode>();
  const roots: AccountNode[] = [];

  for (const acc of accounts) {
    map.set(acc.id, { ...acc, children: [] });
  }

  for (const acc of accounts) {
    const node = map.get(acc.id)!;
    if (acc.parentId) {
      const parent = map.get(acc.parentId);
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    } else {
      roots.push(node);
    }
  }

  return roots;
}

export async function GET() {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'MASTER_DATA', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const accounts = await prisma.account.findMany({
      where: { organizationId: ctx.actor.organizationId },
      orderBy: [{ code: 'asc' }],
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

    const hierarchical = buildHierarchicalList(accounts);

    return ok({ data: hierarchical, count: accounts.length }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function POST(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'MASTER_DATA', action: 'CREATE' });

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

    const body = createSchema.parse(await request.json());

    if (body.normalBalance !== normalBalanceForType[body.type]) {
      return apiError(
        new ValidationError(`Normal balance for ${body.type} must be ${normalBalanceForType[body.type]}`),
        reqId,
      );
    }

    if (body.parentId) {
      const parent = await prisma.account.findUnique({
        where: { id: body.parentId },
        select: { id: true, organizationId: true, type: true, normalBalance: true },
      });
      if (!parent || parent.organizationId !== ctx.actor.organizationId) {
        return apiError(new NotFoundError('Parent account', body.parentId), reqId);
      }
      if (parent.type !== body.type) {
        return apiError(
          new ValidationError('Parent account must be of the same type'),
          reqId,
        );
      }
    }

    const existing = await prisma.account.findUnique({
      where: { organizationId_code: { organizationId: ctx.actor.organizationId, code: body.code } },
      select: { id: true },
    });
    if (existing) {
      return apiError(new ConflictError('An account with this code already exists.'), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: 'POST /api/v1/accounts',
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
            const created = await tx.account.create({
              data: {
                organizationId: ctx.actor.organizationId!,
                code: body.code,
                name: body.name,
                description: body.description ?? undefined,
                type: body.type,
                subCategory: body.subCategory,
                normalBalance: body.normalBalance,
                parentId: body.parentId,
                isPostable: body.isPostable ?? true,
                isReconcilable: body.isReconcilable ?? false,
                requiresDocument: body.requiresDocument ?? false,
                status: body.status ?? 'ACTIVE',
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
                entityId: created.id,
                entityLabel: created.code,
                description: `Created account ${created.code} (${created.name})`,
                changes: {
                  code: { from: null, to: created.code },
                  name: { from: null, to: created.name },
                  type: { from: null, to: created.type },
                  normalBalance: { from: null, to: created.normalBalance },
                  parentId: { from: null, to: created.parentId },
                  isPostable: { from: null, to: created.isPostable },
                  isReconcilable: { from: null, to: created.isReconcilable },
                  requiresDocument: { from: null, to: created.requiresDocument },
                  status: { from: null, to: created.status },
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

            return { status: 201, body: { data: created } };
          },
        ),
    });

    if (outcome.kind === 'REPLAYED') {
      return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    }

    return ok(outcome.result, 201, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}