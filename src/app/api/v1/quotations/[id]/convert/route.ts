import { z } from 'zod';
import { mutateSalesAction } from '@/lib/sales/route-actions';
import { convertQuotation } from '@/lib/sales/quotations';

const amount = z.union([z.string().regex(/^\d+(\.\d{1,6})?$/), z.number().finite()]);
const schema = z.object({
  invoices: z.array(z.object({
    invoiceDate: z.string().min(10), dueDate: z.string().min(10),
    lines: z.array(z.object({
      quotationLineId: z.string().cuid(), quantity: amount, accountId: z.string().cuid(),
      taxRate: amount.optional(), taxAccountId: z.string().optional(),
    })).min(1),
  })).min(1),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return mutateSalesAction({ request, scope: `POST /api/v1/quotations/${id}/convert`, schema, status: 201, handler: (ctx, body) => convertQuotation(ctx, id, body) });
}

