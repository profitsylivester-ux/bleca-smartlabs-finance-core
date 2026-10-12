import { z } from 'zod';
import { mutateSalesAction } from '@/lib/sales/route-actions';
import { sendQuotation } from '@/lib/sales/quotations';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return mutateSalesAction({ request, scope: `POST /api/v1/quotations/${id}/send`, schema: z.object({}), handler: (ctx) => sendQuotation(ctx, id) });
}
