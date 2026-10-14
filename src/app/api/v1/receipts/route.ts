import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { parseSalesBody, runSalesMutation, salesMutationResponse } from '@/lib/sales/api';
import { issueReceipt, listReceipts } from '@/lib/sales/payments';

export async function GET() {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    return ok({ data: await listReceipts(ctx) }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function POST(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const body = parseSalesBody(z.object({ paymentId: z.string().cuid(), supportingDocumentId: z.string().optional() }), await request.json());
    const outcome = await runSalesMutation({ request, context: ctx, scope: 'POST /api/v1/receipts', body, status: 201, handler: () => issueReceipt(ctx, body.paymentId, body.supportingDocumentId) });
    return salesMutationResponse(outcome, reqId, 201);
  } catch (error) {
    return apiError(error, reqId);
  }
}

