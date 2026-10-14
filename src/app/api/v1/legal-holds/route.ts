import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { placeLegalHold } from '@/lib/documents/service';

const schema = z.object({ entityType: z.string().trim().min(2).max(60).toUpperCase(), entityId: z.string().min(1).max(100), reason: z.string().trim().min(5).max(4000) });

export async function POST(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'DOCUMENTS', action: 'ADMINISTER' });
    await authorize(ctx, { module: 'DOCUMENTS', action: 'APPROVE' });
    const input = schema.parse(await request.json());
    const data = await placeLegalHold(ctx, input.entityType, input.entityId, input.reason);
    return ok({ data }, 201, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

