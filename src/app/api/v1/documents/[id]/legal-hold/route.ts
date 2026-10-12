import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { placeLegalHold } from '@/lib/documents/service';

const schema = z.object({ reason: z.string().trim().min(5).max(4000) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { id } = await params;
    await authorize(ctx, { module: 'DOCUMENTS', action: 'ADMINISTER', entity: { type: 'DOCUMENT', id } });
    await authorize(ctx, { module: 'DOCUMENTS', action: 'APPROVE', entity: { type: 'DOCUMENT', id } });
    const result = await placeLegalHold(ctx, 'DOCUMENT', id, schema.parse(await request.json()).reason);
    return ok({ data: result }, 201, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
