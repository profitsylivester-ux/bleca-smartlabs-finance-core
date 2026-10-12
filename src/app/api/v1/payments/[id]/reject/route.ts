import { z } from 'zod';
import { mutateSalesAction } from '@/lib/sales/route-actions';
import { decidePayment } from '@/lib/sales/payments';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const schema = z.object({ reason: z.string().min(5).max(1000) });
  return mutateSalesAction({ request, scope: `POST /api/v1/payments/${id}/reject`, schema, handler: (ctx, body) => decidePayment(ctx, id, 'REJECTED', body.reason) });
}
