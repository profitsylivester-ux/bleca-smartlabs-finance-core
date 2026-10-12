import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { applyDocumentTag } from '@/lib/documents/service';

const schema = z.object({ tagId: z.string().optional(), name: z.string().trim().min(1).max(80).optional() })
  .refine((input) => Boolean(input.tagId || input.name), 'Provide a tagId or name.');

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { id } = await params;
    await authorize(ctx, { module: 'DOCUMENTS', action: 'EDIT', entity: { type: 'DOCUMENT', id } });
    const result = await applyDocumentTag(ctx, id, schema.parse(await request.json()));
    return ok({ data: result }, 201, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
