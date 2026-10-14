import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { ValidationError } from '@/lib/kernel/errors';
import { createDocumentTag, listDocumentTags } from '@/lib/documents/service';

const schema = z.object({ name: z.string().trim().min(1).max(80) });

export async function GET() {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'DOCUMENTS', action: 'VIEW' });
    if (!ctx.actor.organizationId) throw new ValidationError('No organization context');
    const data = await listDocumentTags(ctx.actor.organizationId);
    return ok({ data, count: data.length }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function POST(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'DOCUMENTS', action: 'EDIT' });
    const { name } = schema.parse(await request.json());
    return ok({ data: await createDocumentTag(ctx, name) }, 201, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

