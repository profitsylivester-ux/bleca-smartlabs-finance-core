import { z } from 'zod';
import { mutateSalesAction } from '@/lib/sales/route-actions';
import { submitPayment } from '@/lib/sales/payments';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return mutateSalesAction({ request, scope: `POST /api/v1/payments/${id}/submit`, schema: z.object({}), handler: (ctx) => submitPayment(ctx, id) });
}
