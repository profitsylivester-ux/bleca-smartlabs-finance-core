import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { ValidationError } from '@/lib/kernel/errors';
import { DOCUMENT_CATEGORIES, getDocumentDetail, softDeleteDocument, updateDocument } from '@/lib/documents/service';

const updateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  category: z.enum(DOCUMENT_CATEGORIES).optional(),
  metadata: z.json().nullable().optional(),
  expiryDate: z.string().min(1).nullable().optional(),
  renewalDueAt: z.string().min(1).nullable().optional(),
  renewalOfId: z.string().nullable().optional(),
});

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { id } = await params;
    await authorize(ctx, { module: 'DOCUMENTS', action: 'VIEW', entity: { type: 'DOCUMENT', id } });
    if (!ctx.actor.organizationId) throw new ValidationError('No organization context');
    return ok({ data: await getDocumentDetail(ctx.actor.organizationId, id) }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { id } = await params;
    await authorize(ctx, { module: 'DOCUMENTS', action: 'EDIT', entity: { type: 'DOCUMENT', id } });
    const raw: unknown = await request.json();
    const input = updateSchema.parse(raw);
    const { expiryDate, renewalDueAt, ...rest } = input;
    const result = await updateDocument(ctx, id, {
      ...rest,
      expiryDate: expiryDate === null || expiryDate === undefined ? expiryDate : new Date(expiryDate),
      renewalDueAt: renewalDueAt === null || renewalDueAt === undefined ? renewalDueAt : new Date(renewalDueAt),
      metadata: input.metadata === undefined || input.metadata === null ? input.metadata : input.metadata as Prisma.InputJsonValue,
    });
    return ok({ data: result }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { id } = await params;
    await authorize(ctx, { module: 'DOCUMENTS', action: 'EDIT', entity: { type: 'DOCUMENT', id } });
    return ok({ data: await softDeleteDocument(ctx, id) }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

