import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { parseSalesBody, runSalesMutation, salesMutationResponse } from '@/lib/sales/api';
import { createInvoice, listInvoices } from '@/lib/sales/invoices';

const statuses = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED'] as const;
const amount = z.union([z.string().regex(/^\d+(\.\d{1,6})?$/), z.number().finite()]);
const createSchema = z.object({
  direction: z.enum(['RECEIVABLE', 'PAYABLE']),
  customerId: z.string().cuid().optional(), supplierId: z.string().cuid().optional(),
  quotationId: z.string().cuid().optional(), invoiceDate: z.string().min(10), dueDate: z.string().min(10),
  currencyCode: z.string().length(3).toUpperCase(), reference: z.string().max(200).optional(),
  notes: z.string().max(4000).optional(), isTaxInvoice: z.boolean().optional(),
  taxInvoiceNumber: z.string().max(100).optional(),
  recurrenceFrequency: z.enum(['MONTHLY', 'QUARTERLY', 'ANNUALLY']).optional(),
  recurrenceEndsAt: z.string().min(10).optional(),
  lines: z.array(z.object({
    description: z.string().min(1).max(1000), quantity: amount, unitPrice: amount,
    accountId: z.string().cuid(), taxRate: amount.optional(), taxAccountId: z.string().cuid().optional(),
  })).min(1),
});

export async function GET(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const query = z.object({ status: z.enum(statuses).optional(), direction: z.enum(['RECEIVABLE', 'PAYABLE']).optional() })
      .parse(Object.fromEntries(new URL(request.url).searchParams.entries()));
    return ok({ data: await listInvoices(ctx, query) }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function POST(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const body = parseSalesBody(createSchema, await request.json());
    const outcome = await runSalesMutation({ request, context: ctx, scope: 'POST /api/v1/invoices', body, status: 201, handler: () => createInvoice(ctx, body) });
    return salesMutationResponse(outcome, reqId, 201);
  } catch (error) {
    return apiError(error, reqId);
  }
}

