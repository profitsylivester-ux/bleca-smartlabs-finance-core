import { z } from 'zod';
import { mutateSalesAction } from '@/lib/sales/route-actions';
import { completePayment } from '@/lib/sales/payments';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return mutateSalesAction({ request, scope: `POST /api/v1/payments/${id}/complete`, schema: z.object({}), handler: (ctx) => completePayment(ctx, id) });
}
