import { z } from 'zod';
import { mutateSalesAction } from '@/lib/sales/route-actions';
import { decideDebitNote } from '@/lib/sales/notes';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const schema = z.object({ reason: z.string().max(1000).optional() });
  return mutateSalesAction({ request, scope: `POST /api/v1/debit-notes/${id}/approve`, schema, handler: (ctx, body) => decideDebitNote(ctx, id, 'APPROVED', body.reason) });
}
