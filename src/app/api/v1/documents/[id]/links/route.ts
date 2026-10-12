import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { DOCUMENT_LINK_TYPES, addDocumentLink } from '@/lib/documents/service';

const schema = z.object({
  entityType: z.string().trim().min(2).max(60).toUpperCase(),
  entityId: z.string().min(1).max(100),
  linkType: z.enum(DOCUMENT_LINK_TYPES),
  isPrimary: z.boolean().optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { id } = await params;
    await authorize(ctx, { module: 'DOCUMENTS', action: 'EDIT', entity: { type: 'DOCUMENT', id } });
    const input = schema.parse(await request.json());
    const link = await addDocumentLink(ctx, id, input);
    return ok({ data: link }, 201, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
