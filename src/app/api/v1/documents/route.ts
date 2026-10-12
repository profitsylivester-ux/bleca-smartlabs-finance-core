import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { ValidationError } from '@/lib/kernel/errors';
import { DOCUMENT_CATEGORIES, listDocuments } from '@/lib/documents/service';
import { handleDocumentUpload } from '@/lib/documents/http';

const statuses = ['AVAILABLE', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'ARCHIVED'] as const;

function queryDate(value: string | null, field: string): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ValidationError(`${field} must be a valid date.`);
  return date;
}

export async function GET(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'DOCUMENTS', action: 'VIEW' });
    if (!ctx.actor.organizationId) throw new ValidationError('No organization context');
    const params = new URL(request.url).searchParams;
    const categoryValue = params.get('category');
    const statusValue = params.get('status');
    const parsedLimit = Number(params.get('limit') ?? 50);
    const category = categoryValue ? z.enum(DOCUMENT_CATEGORIES).parse(categoryValue) : undefined;
    const status = statusValue ? z.enum(statuses).parse(statusValue) : undefined;
    const result = await listDocuments(ctx.actor.organizationId, {
      category, status, tag: params.get('tag') ?? undefined,
      entityType: params.get('entityType') ?? undefined,
      entityId: params.get('entityId') ?? undefined,
      expiryFrom: queryDate(params.get('expiryFrom'), 'expiryFrom'),
      expiryTo: queryDate(params.get('expiryTo'), 'expiryTo'),
      search: params.get('q')?.trim() || undefined,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : 50,
    });
    return ok({ data: result, count: result.length }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function POST(request: Request) {
  return handleDocumentUpload(request);
}
