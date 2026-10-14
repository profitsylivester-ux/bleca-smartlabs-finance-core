import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, requestId } from '@/lib/api/responses';
import { ValidationError } from '@/lib/kernel/errors';
import {
  budgetMutationResponse,
  parseBudgetBody,
  requireOrganizationId,
  runBudgetMutation,
} from '@/lib/budgets/api';
import {
  cancelCommitment,
  settleCommitment,
  updateCommitment,
} from '@/lib/budgets/service';

const dateSchema = z.string().min(1).transform((value) => new Date(value));
const amountSchema = z.union([
  z.string().regex(/^\d+(\.\d{1,6})?$/),
  z.number().finite().nonnegative(),
]);
const patchSchema = z.object({
  amount: amountSchema.optional(),
  description: z.string().max(2000).nullable().optional(),
  expectedDate: dateSchema.nullable().optional(),
  status: z.enum(['SETTLED', 'CANCELLED']).optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'COMMITMENTS', action: 'EDIT' });
    const organizationId = requireOrganizationId(ctx);
    const { id } = await params;
    const body = parseBudgetBody(patchSchema, await request.json());
    const outcome = await runBudgetMutation({
      request, context: ctx, requestId: reqId, scope: `PATCH /api/v1/commitments/${id}`, body,
      handler: async (tx) => {
        const actor = { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes };
        const hasEdits = body.amount !== undefined
          || body.description !== undefined
          || body.expectedDate !== undefined;
        if (!hasEdits && !body.status) throw new ValidationError('No commitment changes were supplied.');
        if (hasEdits && body.status) {
          await updateCommitment(
            tx,
            id,
            organizationId,
            { amount: body.amount, description: body.description, expectedDate: body.expectedDate },
            actor,
          );
        }
        const result = body.status === 'SETTLED'
          ? await settleCommitment(tx, id, organizationId, actor)
          : body.status === 'CANCELLED'
            ? await cancelCommitment(tx, id, organizationId, actor)
            : await updateCommitment(
              tx,
              id,
              organizationId,
              { amount: body.amount, description: body.description, expectedDate: body.expectedDate },
              actor,
            );
        return { data: result };
      },
    });
    return budgetMutationResponse(outcome, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'COMMITMENTS', action: 'EDIT' });
    const organizationId = requireOrganizationId(ctx);
    const { id } = await params;
    const outcome = await runBudgetMutation({
      request, context: ctx, requestId: reqId, scope: `DELETE /api/v1/commitments/${id}`, body: {},
      handler: async (tx) => ({
        data: await cancelCommitment(tx, id, organizationId, {
          id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes,
        }),
      }),
    });
    return budgetMutationResponse(outcome, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

