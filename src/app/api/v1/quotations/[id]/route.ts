import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { parseSalesBody, runSalesMutation, salesMutationResponse } from '@/lib/sales/api';
import { cancelDraftQuotation, getQuotation, updateQuotationDraft } from '@/lib/sales/quotations';

const amount = z.union([z.string().regex(/^\d+(\.\d{1,6})?$/), z.number().finite()]);
const updateSchema = z.object({
  customerId: z.string().cuid(), quoteDate: z.string().min(10), validUntil: z.string().min(10),
  currencyCode: z.string().length(3).toUpperCase(), reference: z.string().max(200).optional(),
  notes: z.string().max(4000).optional(),
  lines: z.array(z.object({ description: z.string().min(1).max(1000), quantity: amount, unitPrice: amount })).min(1),
});

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { id } = await params;
    return ok({ data: await getQuotation(ctx, id) }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { id } = await params;
    const body = parseSalesBody(updateSchema, await request.json());
    const outcome = await runSalesMutation({
      request, context: ctx, scope: `PATCH /api/v1/quotations/${id}`, body,
      handler: () => updateQuotationDraft(ctx, id, body),
    });
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
    const outcome = await runSalesMutation({
      request, context: ctx, scope: `DELETE /api/v1/quotations/${id}`, body,
      handler: () => cancelDraftQuotation(ctx, id, body.reason),
    });
    return salesMutationResponse(outcome, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
