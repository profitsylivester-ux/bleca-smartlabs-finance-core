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
import { createTransfer, listBudgetTransfers } from '@/lib/budgets/service';

const amountSchema = z.union([
  z.string().regex(/^\d+(\.\d{1,6})?$/),
  z.number().finite().nonnegative(),
]);
const createSchema = z.object({
  fromLineId: z.string().cuid(),
  toLineId: z.string().cuid(),
  amount: amountSchema,
  reason: z.string().min(3).max(2000),
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
    const data = await prisma.$transaction((tx) => listBudgetTransfers(tx, id, organizationId));
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
    await authorize(ctx, { module: 'BUDGETS', action: 'CREATE' });
    const organizationId = requireOrganizationId(ctx);
    const { id } = await params;
    const body = parseBudgetBody(createSchema, await request.json());
    const outcome = await runBudgetMutation({
      request, context: ctx, requestId: reqId, scope: `POST /api/v1/budgets/${id}/transfers`, body,
      status: 201,
      handler: async (tx) => ({
        data: await createTransfer(
          tx,
          { budgetId: id, organizationId, ...body },
          { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
        ),
      }),
    });
    return budgetMutationResponse(outcome, reqId, 201);
  } catch (error) {
    return apiError(error, reqId);
  }
}
