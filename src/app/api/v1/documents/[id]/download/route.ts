import { recordAuditEvent } from '@/lib/db/with-audit';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, requestId } from '@/lib/api/responses';
import { AuthorizationError, ValidationError } from '@/lib/kernel/errors';
import { verifyDocumentDownload } from '@/lib/documents/download-url';
import { documentForDownload, readDocumentBytes } from '@/lib/documents/service';

function actor(ctx: Awaited<ReturnType<typeof requireContext>>) {
  return { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes };
}

async function logDownloadRefusal(
  ctx: Awaited<ReturnType<typeof requireContext>>,
  id: string,
  reason: string,
) {
  await recordAuditEvent({
    organizationId: ctx.actor.organizationId,
    actor: actor(ctx),
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
    sessionId: ctx.actor.sessionId,
  }, {
    action: 'DOCUMENT_DOWNLOADED', entityType: 'DOCUMENT', entityId: id,
    description: `Document download refused: ${reason}`,
    metadata: { refused: true }, result: 'DENIED', errorMessage: reason,
  });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { id } = await params;
    try {
      await authorize(ctx, { module: 'DOCUMENTS', action: 'VIEW', entity: { type: 'DOCUMENT', id } });
    } catch (error) {
      if (error instanceof AuthorizationError) await logDownloadRefusal(ctx, id, 'permission denied');
      throw error;
    }
    if (!ctx.actor.organizationId) throw new ValidationError('No organization context');
    const token = new URL(request.url).searchParams.get('token') ?? '';
    const signed = verifyDocumentDownload(token);
    if (!signed || signed.documentId !== id || signed.organizationId !== ctx.actor.organizationId || signed.actorId !== ctx.actor.userId) {
      await logDownloadRefusal(ctx, id, 'signed URL is invalid, expired, or belongs to another user');
      throw new AuthorizationError('This download link is invalid or expired.');
    }

    const document = await documentForDownload(ctx.actor.organizationId, id);
    let bytes: Buffer;
    try {
      bytes = await readDocumentBytes(document.storageKey);
    } catch (error) {
      await recordAuditEvent({
        organizationId: ctx.actor.organizationId, actor: actor(ctx), ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent, requestId: ctx.requestId, sessionId: ctx.actor.sessionId,
      }, {
        action: 'DOCUMENT_DOWNLOADED', entityType: 'DOCUMENT', entityId: id,
        description: `Document download failed for ${document.title}`,
        metadata: { fileSize: document.fileSize, version: document.currentVersion },
        result: 'FAILURE', errorMessage: error instanceof Error ? error.message : 'Storage read failed',
      });
      throw error;
    }

    await recordAuditEvent({
      organizationId: ctx.actor.organizationId, actor: actor(ctx), ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent, requestId: ctx.requestId, sessionId: ctx.actor.sessionId,
    }, {
      action: 'DOCUMENT_DOWNLOADED', entityType: 'DOCUMENT', entityId: id,
      entityLabel: document.title,
      description: `Downloaded document ${document.title}`,
      metadata: { checksum: document.checksum, fileSize: bytes.length, version: document.currentVersion },
      result: 'SUCCESS',
    });

    const safeName = encodeURIComponent(document.fileName).replace(/['()]/g, (value) => `%${value.charCodeAt(0).toString(16)}`);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'content-type': document.mimeType,
        'content-length': String(bytes.length),
        'content-disposition': `inline; filename*=UTF-8''${safeName}`,
        'cache-control': 'private, no-store, max-age=0',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    return apiError(error, reqId);
  }
}
