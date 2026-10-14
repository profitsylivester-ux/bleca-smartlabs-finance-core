import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import {
  budgetMutationResponse,
  parseBudgetBody,
  requireOrganizationId,
  runBudgetMutation,
} from '@/lib/budgets/api';
import { createCommitment, listCommitments } from '@/lib/budgets/service';

const sources = ['INVOICE', 'PURCHASE_COMMITMENT', 'CONTRACT', 'PAYMENT_SCHEDULE', 'MANUAL'] as const;
const statuses = ['OPEN', 'PARTIALLY_SETTLED', 'SETTLED', 'CANCELLED', 'EXPIRED', 'OVERDUE'] as const;
const dateSchema = z.string().datetime().transform((value) => new Date(value));
const amountSchema = z.union([
  z.string().regex(/^\d+(\.\d{1,6})?$/),
  z.number().finite().nonnegative(),
]);
const createSchema = z.object({
  budgetId: z.string().cuid().optional(),
  budgetLineId: z.string().cuid().optional(),
  accountId: z.string().cuid(),
  source: z.enum(sources),
  sourceId: z.string().max(200).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  amount: amountSchema,
  currencyCode: z.string().length(3),
  commitmentDate: dateSchema,
  expectedDate: dateSchema.nullable().optional(),
  projectId: z.string().cuid().nullable().optional(),
  departmentId: z.string().cuid().nullable().optional(),
  fundingSourceId: z.string().cuid().nullable().optional(),
});
const filterSchema = z.object({
  budgetId: z.string().optional(),
  status: z.enum(statuses).optional(),
  accountId: z.string().optional(),
});

export async function GET(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'COMMITMENTS', action: 'VIEW' });
    const organizationId = requireOrganizationId(ctx);
    const filters = parseBudgetBody(
      filterSchema,
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );
    const data = await prisma.$transaction((tx) => listCommitments(tx, organizationId, filters));
    return ok({ data }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function POST(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'COMMITMENTS', action: 'CREATE' });
    const organizationId = requireOrganizationId(ctx);
    const body = parseBudgetBody(createSchema, await request.json());
    const outcome = await runBudgetMutation({
      request, context: ctx, requestId: reqId, scope: 'POST /api/v1/commitments', body,
      status: 201,
      handler: async (tx) => ({
        data: await createCommitment(
          tx,
          { ...body, organizationId, createdById: ctx.actor.userId },
          { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
        ),
      }),
    });
    return budgetMutationResponse(outcome, reqId, 201);
  } catch (error) {
    return apiError(error, reqId);
  }
}

