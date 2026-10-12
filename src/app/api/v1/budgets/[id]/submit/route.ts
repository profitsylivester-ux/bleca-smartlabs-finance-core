import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, requestId } from '@/lib/api/responses';
import { budgetMutationResponse, requireOrganizationId, runBudgetMutation } from '@/lib/budgets/api';
import { submitBudget } from '@/lib/budgets/service';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'BUDGETS', action: 'SUBMIT' });
    const organizationId = requireOrganizationId(ctx);
    const { id } = await params;
    const outcome = await runBudgetMutation({
      request, context: ctx, requestId: reqId, scope: `POST /api/v1/budgets/${id}/submit`, body: {},
      handler: async (tx) => ({
        data: await submitBudget(tx, id, organizationId, {
          id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes,
        }),
      }),
    });
    return budgetMutationResponse(outcome, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
