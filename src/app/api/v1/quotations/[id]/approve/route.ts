import { z } from 'zod';
import { mutateSalesAction } from '@/lib/sales/route-actions';
import { decideQuotation } from '@/lib/sales/quotations';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const schema = z.object({ reason: z.string().max(1000).optional() });
  return mutateSalesAction({ request, scope: `POST /api/v1/quotations/${id}/approve`, schema, handler: (ctx, body) => decideQuotation(ctx, id, 'APPROVED', body.reason) });
}
