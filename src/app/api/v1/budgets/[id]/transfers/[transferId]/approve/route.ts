import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, requestId } from '@/lib/api/responses';
import { budgetMutationResponse, requireOrganizationId, runBudgetMutation } from '@/lib/budgets/api';
import { approveTransfer } from '@/lib/budgets/service';
import { NotFoundError } from '@/lib/kernel/errors';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; transferId: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'BUDGETS', action: 'APPROVE' });
    const organizationId = requireOrganizationId(ctx);
    const { id, transferId } = await params;
    const outcome = await runBudgetMutation({
      request, context: ctx, requestId: reqId,
      scope: `POST /api/v1/budgets/${id}/transfers/${transferId}/approve`, body: {},
      handler: async (tx) => {
        const exists = await tx.budgetTransfer.findFirst({
          where: { id: transferId, budgetId: id, organizationId },
          select: { id: true },
        });
        if (!exists) throw new NotFoundError('Budget transfer', transferId);
        return {
          data: await approveTransfer(tx, transferId, organizationId, {
            id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes,
          }),
        };
      },
    });
    return budgetMutationResponse(outcome, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
