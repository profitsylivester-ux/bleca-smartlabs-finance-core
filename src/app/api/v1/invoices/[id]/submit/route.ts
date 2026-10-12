import { z } from 'zod';
import { mutateSalesAction } from '@/lib/sales/route-actions';
import { submitInvoice } from '@/lib/sales/invoices';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return mutateSalesAction({ request, scope: `POST /api/v1/invoices/${id}/submit`, schema: z.object({}), handler: (ctx) => submitInvoice(ctx, id) });
}
