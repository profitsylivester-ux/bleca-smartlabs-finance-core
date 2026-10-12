import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { removeDocumentLink } from '@/lib/documents/service';

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; linkId: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { id, linkId } = await params;
    await authorize(ctx, { module: 'DOCUMENTS', action: 'EDIT', entity: { type: 'DOCUMENT', id } });
    const result = await removeDocumentLink(ctx, id, linkId);
    return ok({ data: result }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
