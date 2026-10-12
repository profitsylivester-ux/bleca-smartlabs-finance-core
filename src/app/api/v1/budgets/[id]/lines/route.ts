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
import { getBudgetVsActual, upsertBudgetLines } from '@/lib/budgets/service';

const lineSchema = z.object({
  accountId: z.string().cuid(),
  amount: z.union([
    z.string().regex(/^\d+(\.\d{1,6})?$/),
    z.number().finite().nonnegative(),
  ]),
  description: z.string().max(2000).nullable().optional(),
  phasing: z.record(z.string(), z.union([
    z.string().regex(/^\d+(\.\d{1,6})?$/),
    z.number().finite().nonnegative(),
  ])).nullable().optional(),
});
const schema = z.object({ lines: z.array(lineSchema).min(1) });

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
    const view = await prisma.$transaction((tx) => getBudgetVsActual(tx, id, organizationId));
    return ok({ data: view.lines }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'BUDGETS', action: 'EDIT' });
    const organizationId = requireOrganizationId(ctx);
    const { id } = await params;
    const body = parseBudgetBody(schema, await request.json());
    const outcome = await runBudgetMutation({
      request, context: ctx, requestId: reqId, scope: `PUT /api/v1/budgets/${id}/lines`, body,
      handler: async (tx) => ({
        data: await upsertBudgetLines(
          tx,
          id,
          organizationId,
          body.lines,
          { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
        ),
      }),
    });
    return budgetMutationResponse(outcome, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
