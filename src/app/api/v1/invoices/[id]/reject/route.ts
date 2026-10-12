import { z } from 'zod';
import { mutateSalesAction } from '@/lib/sales/route-actions';
import { decideInvoice } from '@/lib/sales/invoices';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const schema = z.object({ reason: z.string().min(5).max(1000) });
  return mutateSalesAction({ request, scope: `POST /api/v1/invoices/${id}/reject`, schema, handler: (ctx, body) => decideInvoice(ctx, id, 'REJECTED', body.reason) });
}
