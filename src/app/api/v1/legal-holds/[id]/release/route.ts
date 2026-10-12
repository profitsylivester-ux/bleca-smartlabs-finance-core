import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { releaseLegalHold } from '@/lib/documents/service';

const schema = z.object({ reason: z.string().trim().min(5).max(4000) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'DOCUMENTS', action: 'ADMINISTER' });
    const { id } = await params;
    const input = schema.parse(await request.json());
    return ok({ data: await releaseLegalHold(ctx, id, input.reason) }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
