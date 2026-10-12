import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { parseSalesBody, runSalesMutation, salesMutationResponse } from '@/lib/sales/api';
import { cancelDraftPayment, getPayment, updatePaymentDraft } from '@/lib/sales/payments';

const patchSchema = z.object({ paymentDate: z.string().min(10).optional(), reference: z.string().max(200).nullable().optional(), description: z.string().max(2000).nullable().optional() });

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { id } = await params;
    return ok({ data: await getPayment(ctx, id) }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { id } = await params;
    const body = parseSalesBody(patchSchema, await request.json());
    const outcome = await runSalesMutation({ request, context: ctx, scope: `PATCH /api/v1/payments/${id}`, body, handler: () => updatePaymentDraft(ctx, id, body) });
    return salesMutationResponse(outcome, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { id } = await params;
    const body = parseSalesBody(z.object({ reason: z.string().min(5).max(1000) }), await request.json());
    const outcome = await runSalesMutation({ request, context: ctx, scope: `DELETE /api/v1/payments/${id}`, body, handler: () => cancelDraftPayment(ctx, id, body.reason) });
    return salesMutationResponse(outcome, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
