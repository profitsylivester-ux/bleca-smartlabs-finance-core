import { z } from 'zod';
import { mutateSalesAction } from '@/lib/sales/route-actions';
import { reversePayment } from '@/lib/sales/payments';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const schema = z.object({ reason: z.string().min(5).max(1000) });
  return mutateSalesAction({ request, scope: `POST /api/v1/payments/${id}/reverse`, schema, handler: (ctx, body) => reversePayment(ctx, id, body.reason) });
}
