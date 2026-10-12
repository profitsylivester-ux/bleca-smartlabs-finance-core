import { z } from 'zod';
import { mutateSalesAction } from '@/lib/sales/route-actions';
import { decidePayment } from '@/lib/sales/payments';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const schema = z.object({ reason: z.string().max(1000).optional() });
  return mutateSalesAction({ request, scope: `POST /api/v1/payments/${id}/approve`, schema, handler: (ctx, body) => decidePayment(ctx, id, 'APPROVED', body.reason) });
}
