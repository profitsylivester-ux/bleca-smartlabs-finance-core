import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { parseSalesBody, runSalesMutation, salesMutationResponse } from '@/lib/sales/api';
import { createCreditNote, listCreditNotes } from '@/lib/sales/notes';

const amount = z.union([z.string().regex(/^\d+(\.\d{1,6})?$/), z.number().finite()]);
const reasons = ['RETURN', 'PRICING_ADJUSTMENT', 'DAMAGED_GOODS', 'DUPLICATE_BILLING', 'SERVICE_NOT_RENDERED', 'TAX_ADJUSTMENT', 'OVERCHARGE', 'UNDERCHARGE', 'OTHER'] as const;
const schema = z.object({ invoiceId: z.string().cuid(), reasonCode: z.enum(reasons), reason: z.string().min(5).max(1000), amount, taxAmount: amount.optional() });

export async function GET() {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    return ok({ data: await listCreditNotes(ctx) }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function POST(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const body = parseSalesBody(schema, await request.json());
    const outcome = await runSalesMutation({ request, context: ctx, scope: 'POST /api/v1/credit-notes', body, status: 201, handler: () => createCreditNote(ctx, body) });
    return salesMutationResponse(outcome, reqId, 201);
  } catch (error) {
    return apiError(error, reqId);
  }
}

