import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, requestId } from '@/lib/api/responses';
import { budgetMutationResponse, requireOrganizationId, runBudgetMutation } from '@/lib/budgets/api';
import { approveRevision } from '@/lib/budgets/service';
import { NotFoundError } from '@/lib/kernel/errors';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; revId: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'BUDGETS', action: 'APPROVE' });
    const organizationId = requireOrganizationId(ctx);
    const { id, revId } = await params;
    const outcome = await runBudgetMutation({
      request, context: ctx, requestId: reqId,
      scope: `POST /api/v1/budgets/${id}/revisions/${revId}/approve`, body: {},
      handler: async (tx) => {
        const revisionExists = await tx.budgetRevision.findFirst({
          where: { id: revId, budgetId: id, organizationId },
          select: { id: true },
        });
        if (!revisionExists) throw new NotFoundError('Budget revision', revId);
        const revision = await approveRevision(tx, revId, organizationId, {
          id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes,
        });
        return { data: revision };
      },
    });
    return budgetMutationResponse(outcome, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
