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
import { getBudgetVsActual, updateBudget } from '@/lib/budgets/service';

const dateSchema = z.string().min(1).transform((value) => new Date(value));
const patchSchema = z.object({
  code: z.string().min(2).max(50).optional(),
  name: z.string().min(2).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  periodType: z.enum(['MONTHLY', 'QUARTERLY', 'ANNUAL']).optional(),
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
  projectId: z.string().cuid().nullable().optional(),
  departmentId: z.string().cuid().nullable().optional(),
  fundingSourceId: z.string().cuid().nullable().optional(),
  costCentreId: z.string().cuid().nullable().optional(),
  activity: z.string().max(200).nullable().optional(),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'BUDGETS', action: 'VIEW' });
    const organizationId = requireOrganizationId(ctx);
    const { id } = await params;
    const data = await prisma.$transaction((tx) => getBudgetVsActual(tx, id, organizationId));
    return ok({ data }, 200, reqId);
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
    await authorize(ctx, { module: 'BUDGETS', action: 'EDIT' });
    const organizationId = requireOrganizationId(ctx);
    const { id } = await params;
    const body = parseBudgetBody(patchSchema, await request.json());
    const outcome = await runBudgetMutation({
      request,
      context: ctx,
      requestId: reqId,
      scope: `PATCH /api/v1/budgets/${id}`,
      body,
      handler: async (tx) => ({
        data: await updateBudget(
          tx,
          id,
          organizationId,
          body,
          { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
        ),
      }),
    });
    return budgetMutationResponse(outcome, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

