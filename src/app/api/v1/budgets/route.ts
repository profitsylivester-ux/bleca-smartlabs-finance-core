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
import { createBudget, listBudgets } from '@/lib/budgets/service';

const budgetLevels = ['COMPANY', 'DEPARTMENT', 'PROJECT', 'FUNDING', 'ACTIVITY'] as const;
const budgetStatuses = [
  'DRAFT', 'SUBMITTED', 'APPROVED', 'ACTIVE', 'REVISED', 'CLOSED', 'EXPIRED', 'REJECTED',
] as const;
const periodTypes = ['MONTHLY', 'QUARTERLY', 'ANNUAL'] as const;
const amountSchema = z.union([
  z.string().regex(/^\d+(\.\d{1,6})?$/),
  z.number().finite().nonnegative(),
]);
const dateSchema = z.string().min(1).transform((value) => new Date(value));

const lineSchema = z.object({
  accountId: z.string().cuid(),
  amount: amountSchema,
  description: z.string().max(2000).nullable().optional(),
  phasing: z.record(z.string(), z.union([
    z.string().regex(/^\d+(\.\d{1,6})?$/),
    z.number().finite().nonnegative(),
  ])).nullable().optional(),
});

const createSchema = z.object({
  code: z.string().min(2).max(50),
  name: z.string().min(2).max(200),
  description: z.string().max(2000).nullable().optional(),
  type: z.enum(budgetLevels),
  periodType: z.enum(periodTypes),
  startDate: dateSchema,
  endDate: dateSchema,
  currencyCode: z.string().length(3),
  projectId: z.string().cuid().nullable().optional(),
  departmentId: z.string().cuid().nullable().optional(),
  fundingSourceId: z.string().cuid().nullable().optional(),
  costCentreId: z.string().cuid().nullable().optional(),
  activity: z.string().max(200).nullable().optional(),
  lines: z.array(lineSchema).min(1),
});

const filterSchema = z.object({
  status: z.enum(budgetStatuses).optional(),
  type: z.enum(budgetLevels).optional(),
  projectId: z.string().optional(),
  departmentId: z.string().optional(),
  fundingSourceId: z.string().optional(),
  dateFrom: dateSchema.optional(),
  dateTo: dateSchema.optional(),
});

export async function GET(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'BUDGETS', action: 'VIEW' });
    const organizationId = requireOrganizationId(ctx);
    const search = new URL(request.url).searchParams;
    const filters = parseBudgetBody(filterSchema, Object.fromEntries(search.entries()));
    const data = await prisma.$transaction((tx) => listBudgets(tx, organizationId, filters));
    return ok({ data }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function POST(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'BUDGETS', action: 'CREATE' });
    const organizationId = requireOrganizationId(ctx);
    const body = parseBudgetBody(createSchema, await request.json());
    const outcome = await runBudgetMutation({
      request,
      context: ctx,
      requestId: reqId,
      scope: 'POST /api/v1/budgets',
      body,
      status: 201,
      handler: async (tx) => ({
        data: await createBudget(
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


