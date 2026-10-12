import { z } from 'zod';
import { mutateSalesAction } from '@/lib/sales/route-actions';
import { submitCreditNote } from '@/lib/sales/notes';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return mutateSalesAction({ request, scope: `POST /api/v1/credit-notes/${id}/submit`, schema: z.object({}), handler: (ctx) => submitCreditNote(ctx, id) });
}
