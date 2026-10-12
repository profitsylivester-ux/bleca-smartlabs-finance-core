import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { parseSalesBody, runSalesMutation, salesMutationResponse } from '@/lib/sales/api';
import { cancelDraftAdjustmentNote, getCreditNote, updateAdjustmentNoteDraft } from '@/lib/sales/notes';

const reasons = ['RETURN', 'PRICING_ADJUSTMENT', 'DAMAGED_GOODS', 'DUPLICATE_BILLING', 'SERVICE_NOT_RENDERED', 'TAX_ADJUSTMENT', 'OVERCHARGE', 'UNDERCHARGE', 'OTHER'] as const;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { id } = await params;
    return ok({ data: await getCreditNote(ctx, id) }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { id } = await params;
    const body = parseSalesBody(z.object({ reasonCode: z.enum(reasons).optional(), reason: z.string().min(5).max(1000).optional() }), await request.json());
    const outcome = await runSalesMutation({ request, context: ctx, scope: `PATCH /api/v1/credit-notes/${id}`, body, handler: () => updateAdjustmentNoteDraft(ctx, 'CREDIT_NOTE', id, body) });
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
    const outcome = await runSalesMutation({ request, context: ctx, scope: `DELETE /api/v1/credit-notes/${id}`, body, handler: () => cancelDraftAdjustmentNote(ctx, 'CREDIT_NOTE', id, body.reason) });
    return salesMutationResponse(outcome, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
