import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { ValidationError } from '@/lib/kernel/errors';
import { searchDocuments } from '@/lib/documents/service';

export async function GET(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'DOCUMENTS', action: 'VIEW' });
    if (!ctx.actor.organizationId) throw new ValidationError('No organization context');
    const query = new URL(request.url).searchParams.get('q') ?? '';
    const result = await searchDocuments(ctx.actor.organizationId, query);
    return ok({ data: result, count: result.length }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

