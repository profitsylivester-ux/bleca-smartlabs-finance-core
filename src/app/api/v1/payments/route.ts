import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { parseSalesBody, runSalesMutation, salesMutationResponse } from '@/lib/sales/api';
import { createPayment, listPayments } from '@/lib/sales/payments';

const statuses = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'COMPLETED', 'REVERSED', 'CANCELLED'] as const;
const amount = z.union([z.string().regex(/^\d+(\.\d{1,6})?$/), z.number().finite()]);
const allocation = z.object({ invoiceId: z.string().cuid(), amount });
const createSchema = z.object({
  direction: z.enum(['INBOUND', 'OUTBOUND']), customerId: z.string().cuid().optional(), supplierId: z.string().cuid().optional(),
  treasuryAccountId: z.string().cuid(), currencyCode: z.string().length(3).toUpperCase(), amount,
  paymentDate: z.string().min(10), allocationMode: z.enum(['MANUAL', 'AUTOMATIC', 'FIFO']).optional(),
  onAccountAccountId: z.string().cuid().optional(), reference: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  methods: z.array(z.object({ method: z.enum(['CASH', 'BANK_TRANSFER', 'MOBILE_MONEY', 'PAYMENT_GATEWAY', 'CHEQUE', 'CARD', 'OTHER']), amount, reference: z.string().max(200).optional() })).min(1),
  allocations: z.array(allocation).optional(),
});

export async function GET(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const query = z.object({ status: z.enum(statuses).optional(), direction: z.enum(['INBOUND', 'OUTBOUND']).optional() })
      .parse(Object.fromEntries(new URL(request.url).searchParams.entries()));
    return ok({ data: await listPayments(ctx, query) }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function POST(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const body = parseSalesBody(createSchema, await request.json());
    const outcome = await runSalesMutation({ request, context: ctx, scope: 'POST /api/v1/payments', body, status: 201, handler: () => createPayment(ctx, body) });
    return salesMutationResponse(outcome, reqId, 201);
  } catch (error) {
    return apiError(error, reqId);
  }
}

