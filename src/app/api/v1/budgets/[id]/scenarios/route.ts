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
import { createScenario, listBudgetScenarios } from '@/lib/budgets/service';

const createSchema = z.object({
  kind: z.enum(['BEST_CASE', 'EXPECTED_CASE', 'WORST_CASE', 'CUSTOM']),
  name: z.string().min(2).max(200),
  description: z.string().max(2000).nullable().optional(),
  adjustmentFactor: z.union([
    z.string().regex(/^\d+(\.\d{1,6})?$/),
    z.number().finite().nonnegative(),
  ]),
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
    const data = await prisma.$transaction((tx) => listBudgetScenarios(tx, id, organizationId));
    return ok({ data }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'BUDGETS', action: 'CONFIGURE' });
    const organizationId = requireOrganizationId(ctx);
    const { id } = await params;
    const body = parseBudgetBody(createSchema, await request.json());
    const outcome = await runBudgetMutation({
      request, context: ctx, requestId: reqId, scope: `POST /api/v1/budgets/${id}/scenarios`, body,
      status: 201,
      handler: async (tx) => ({
        data: await createScenario(
          tx,
          { budgetId: id, organizationId, ...body, createdById: ctx.actor.userId },
          { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
        ),
      }),
    });
    return budgetMutationResponse(outcome, reqId, 201);
  } catch (error) {
    return apiError(error, reqId);
  }
}
