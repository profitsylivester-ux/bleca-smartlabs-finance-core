import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { ValidationError } from '@/lib/kernel/errors';
import { DOCUMENT_CATEGORIES, listRetentionPolicies, saveRetentionPolicy } from '@/lib/documents/service';

const schema = z.object({
  name: z.string().trim().min(1).max(160),
  category: z.enum(DOCUMENT_CATEGORIES),
  retentionMonths: z.number().int().min(0).max(1200),
  action: z.enum(['ARCHIVE', 'DELETE', 'RETAIN_FOREVER']),
  legalBasis: z.string().trim().min(1).max(4000),
  isActive: z.boolean().optional(),
});

export async function GET() {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'DOCUMENTS', action: 'VIEW' });
    if (!ctx.actor.organizationId) throw new ValidationError('No organization context');
    const data = await listRetentionPolicies(ctx.actor.organizationId);
    return ok({ data, count: data.length }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function POST(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'DOCUMENTS', action: 'CONFIGURE' });
    const input = schema.parse(await request.json());
    return ok({ data: await saveRetentionPolicy(ctx, input) }, 201, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

