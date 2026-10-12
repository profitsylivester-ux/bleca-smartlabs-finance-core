import { z } from 'zod';
import { mutateSalesAction } from '@/lib/sales/route-actions';
import { setPaymentAllocations } from '@/lib/sales/payments';

const amount = z.union([z.string().regex(/^\d+(\.\d{1,6})?$/), z.number().finite()]);
const schema = z.object({ allocations: z.array(z.object({ invoiceId: z.string().cuid(), amount })).min(1) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return mutateSalesAction({ request, scope: `POST /api/v1/payments/${id}/allocations`, schema, handler: (ctx, body) => setPaymentAllocations(ctx, id, body.allocations) });
}
