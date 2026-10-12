import { z } from 'zod';
import { mutateSalesAction } from '@/lib/sales/route-actions';
import { acceptQuotation } from '@/lib/sales/quotations';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return mutateSalesAction({ request, scope: `POST /api/v1/quotations/${id}/accept`, schema: z.object({}), handler: (ctx) => acceptQuotation(ctx, id) });
}
