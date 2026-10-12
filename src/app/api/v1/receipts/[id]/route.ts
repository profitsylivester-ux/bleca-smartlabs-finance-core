import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { parseSalesBody, runSalesMutation, salesMutationResponse } from '@/lib/sales/api';
import { getReceipt, voidReceipt } from '@/lib/sales/payments';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { id } = await params;
    return ok({ data: await getReceipt(ctx, id) }, 200, reqId);
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
    const outcome = await runSalesMutation({ request, context: ctx, scope: `DELETE /api/v1/receipts/${id}`, body, handler: () => voidReceipt(ctx, id, body.reason) });
    return salesMutationResponse(outcome, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
