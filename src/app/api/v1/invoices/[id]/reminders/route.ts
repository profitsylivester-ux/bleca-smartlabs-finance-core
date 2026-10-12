import { z } from 'zod';
import { mutateSalesAction } from '@/lib/sales/route-actions';
import { createInvoiceReminder } from '@/lib/sales/invoices';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const schema = z.object({ message: z.string().max(2000).optional() });
  return mutateSalesAction({ request, scope: `POST /api/v1/invoices/${id}/reminders`, schema, handler: (ctx, body) => createInvoiceReminder(ctx, id, body.message) });
}
