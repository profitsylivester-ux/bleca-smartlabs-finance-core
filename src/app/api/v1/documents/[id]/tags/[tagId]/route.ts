import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { removeDocumentTag } from '@/lib/documents/service';

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; tagId: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { id, tagId } = await params;
    await authorize(ctx, { module: 'DOCUMENTS', action: 'EDIT', entity: { type: 'DOCUMENT', id } });
    await removeDocumentTag(ctx, id, tagId);
    return ok({ data: { removed: true } }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
