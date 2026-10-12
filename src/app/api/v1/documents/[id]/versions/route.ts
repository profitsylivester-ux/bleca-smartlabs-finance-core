import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { ValidationError } from '@/lib/kernel/errors';
import { logDocumentUploadFailure, parseDocumentUploadForm } from '@/lib/documents/http';
import { addDocumentVersion } from '@/lib/documents/service';
import { env } from '@/lib/env';
import type { RequestContext } from '@/lib/kernel/context';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  let ctx: RequestContext | null = null;
  try {
    ctx = await requireContext();
    const { id } = await params;
    await authorize(ctx, { module: 'DOCUMENTS', action: 'EDIT', entity: { type: 'DOCUMENT', id } });
    const length = Number(request.headers.get('content-length') ?? 0);
    if (Number.isFinite(length) && length > env().DOCUMENT_MAX_FILE_BYTES + 65_536) {
      throw new ValidationError(`The request exceeds the configured ${env().DOCUMENT_MAX_FILE_BYTES} byte file size limit.`);
    }
    const input = await parseDocumentUploadForm(await request.formData());
    if (!input.reason?.trim()) throw new ValidationError('A reason is required for each new version.');
    const result = await addDocumentVersion(ctx, id, { ...input, reason: input.reason });
    return ok({ data: result.document, deduplicated: result.deduplicated }, result.deduplicated ? 200 : 201, reqId);
  } catch (error) {
    if (ctx) {
      try { await logDocumentUploadFailure(ctx, error); } catch (auditError) {
        console.error('[documents] could not audit a failed version upload', { requestId: reqId, auditError });
      }
    }
    return apiError(error, reqId);
  }
}
