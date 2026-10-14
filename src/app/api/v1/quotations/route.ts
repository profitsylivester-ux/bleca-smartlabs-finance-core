import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { parseSalesBody, runSalesMutation, salesMutationResponse } from '@/lib/sales/api';
import { createQuotation, listQuotations } from '@/lib/sales/quotations';

const statuses = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'SENT', 'ACCEPTED', 'EXPIRED', 'CONVERTED', 'CANCELLED'] as const;
const amount = z.union([z.string().regex(/^\d+(\.\d{1,6})?$/), z.number().finite()]);
const createSchema = z.object({
  customerId: z.string().cuid(),
  quoteDate: z.string().min(10),
  validUntil: z.string().min(10),
  currencyCode: z.string().length(3).toUpperCase(),
  reference: z.string().max(200).optional(),
  notes: z.string().max(4000).optional(),
  lines: z.array(z.object({ description: z.string().min(1).max(1000), quantity: amount, unitPrice: amount })).min(1),
});

export async function GET(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const query = z.object({ status: z.enum(statuses).optional() }).parse(Object.fromEntries(new URL(request.url).searchParams.entries()));
    return ok({ data: await listQuotations(ctx, query.status) }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function POST(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const body = parseSalesBody(createSchema, await request.json());
    const outcome = await runSalesMutation({
      request, context: ctx, scope: 'POST /api/v1/quotations', body, status: 201,
      handler: () => createQuotation(ctx, body),
    });
    return salesMutationResponse(outcome, reqId, 201);
  } catch (error) {
    return apiError(error, reqId);
  }
}

