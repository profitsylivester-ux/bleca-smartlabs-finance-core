import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { ValidationError } from '@/lib/kernel/errors';
import { env } from '@/lib/env';
import { signDocumentDownload } from '@/lib/documents/download-url';
import { documentForDownload } from '@/lib/documents/service';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { id } = await params;
    await authorize(ctx, { module: 'DOCUMENTS', action: 'VIEW', entity: { type: 'DOCUMENT', id } });
    if (!ctx.actor.organizationId) throw new ValidationError('No organization context');
    const document = await documentForDownload(ctx.actor.organizationId, id);
    const ttlSeconds = env().DOCUMENT_SIGNED_URL_TTL_SECONDS;
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const token = signDocumentDownload({
      documentId: document.id,
      organizationId: ctx.actor.organizationId,
      actorId: ctx.actor.userId,
      expiresAt,
    });
    return ok({
      data: {
        signedUrl: `/api/v1/documents/${encodeURIComponent(id)}/download?token=${encodeURIComponent(token)}`,
        expiresAt: new Date(expiresAt).toISOString(),
        expiresInSeconds: ttlSeconds,
      },
    }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
