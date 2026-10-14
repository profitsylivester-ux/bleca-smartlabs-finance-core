import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { env } from '@/lib/env';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { recordAuditEvent } from '@/lib/db/with-audit';
import { ValidationError } from '@/lib/kernel/errors';
import type { RequestContext } from '@/lib/kernel/context';
import { DOCUMENT_CATEGORIES, type UploadDocumentInput, uploadDocument } from './service';

function parseDate(value: FormDataEntryValue | null, label: string): Date | undefined {
  if (value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValidationError(`${label} must be an ISO date.`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new ValidationError(`${label} is invalid.`);
  return date;
}

function parseMetadata(value: FormDataEntryValue | null): Prisma.InputJsonValue | undefined {
  if (value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new ValidationError('Metadata must be JSON text.');
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null) return undefined;
    return parsed as Prisma.InputJsonValue;
  } catch {
    throw new ValidationError('Metadata must contain valid JSON.');
  }
}

export async function parseDocumentUploadForm(form: FormData): Promise<UploadDocumentInput & { reason?: string }> {
  const file = form.get('file');
  if (!(file instanceof File)) throw new ValidationError('Choose a PDF or image file to upload.');
  const fields = z.object({
    title: z.string().trim().max(200).optional(),
    description: z.string().max(5000).optional(),
    category: z.enum(DOCUMENT_CATEGORIES),
    reason: z.string().max(1000).optional(),
    renewalOfId: z.string().optional(),
  }).parse({
    title: form.get('title') || undefined,
    description: form.get('description') || undefined,
    category: form.get('category'),
    reason: form.get('reason') || undefined,
    renewalOfId: form.get('renewalOfId') || undefined,
  });
  const bytes = Buffer.from(await file.arrayBuffer());
  if (Number.isFinite(file.size) && file.size > env().DOCUMENT_MAX_FILE_BYTES) {
    throw new ValidationError(`The file exceeds the configured ${env().DOCUMENT_MAX_FILE_BYTES} byte size limit.`);
  }
  const title = fields.title?.trim() || file.name.replace(/\.[^.]+$/, '') || file.name;
  return {
    fileName: file.name,
    mimeType: file.type,
    bytes,
    title,
    description: fields.description,
    category: fields.category,
    metadata: parseMetadata(form.get('metadata')),
    expiryDate: parseDate(form.get('expiryDate'), 'Expiry date') ?? null,
    renewalDueAt: parseDate(form.get('renewalDueAt'), 'Renewal due date') ?? null,
    renewalOfId: fields.renewalOfId || null,
    reason: fields.reason,
  };
}

export async function logDocumentUploadFailure(ctx: RequestContext, error: unknown) {
  const reason = error instanceof Error ? error.message : 'The document upload failed.';
  await recordAuditEvent({
    organizationId: ctx.actor.organizationId,
    actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
    sessionId: ctx.actor.sessionId,
  }, {
    action: 'DOCUMENT_UPLOADED',
    entityType: 'DOCUMENT',
    description: 'Document upload failed',
    metadata: { outcome: 'FAILED' },
    result: 'FAILURE',
    errorMessage: reason,
    securityEvent: {
      type: 'MALFORMED_UPLOAD',
      severity: 'LOW',
      description: 'A document upload did not pass validation or storage.',
      subjectType: 'DOCUMENT',
      detail: { error: reason },
    },
  });
}

/** Shared handler for POST /documents and POST /documents/upload. */
export async function handleDocumentUpload(request: Request) {
  const reqId = await requestId();
  let ctx: RequestContext | null = null;
  try {
    ctx = await requireContext();
    await authorize(ctx, { module: 'DOCUMENTS', action: 'CONFIGURE' });
    const contentLength = Number(request.headers.get('content-length') ?? 0);
    const maxBytes = env().DOCUMENT_MAX_FILE_BYTES;
    if (Number.isFinite(contentLength) && contentLength > maxBytes + 65_536) {
      throw new ValidationError(`The request exceeds the configured ${maxBytes} byte file size limit.`);
    }
    const form = await request.formData();
    const input = await parseDocumentUploadForm(form);
    const result = await uploadDocument(ctx, input);
    return ok({ data: result.document, deduplicated: result.deduplicated }, result.deduplicated ? 200 : 201, reqId);
  } catch (error) {
    if (ctx) {
      try { await logDocumentUploadFailure(ctx, error); } catch (auditError) {
        console.error('[documents] could not audit a failed upload', { requestId: reqId, auditError });
      }
    }
    return apiError(error, reqId);
  }
}
