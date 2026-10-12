import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';
import { DOCUMENT_CATEGORIES, saveRetentionPolicy } from '@/lib/documents/service';

const schema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  category: z.enum(DOCUMENT_CATEGORIES).optional(),
  retentionMonths: z.number().int().min(0).max(1200).optional(),
  action: z.enum(['ARCHIVE', 'DELETE', 'RETAIN_FOREVER']).optional(),
  legalBasis: z.string().trim().min(1).max(4000).optional(),
  isActive: z.boolean().optional(),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'DOCUMENTS', action: 'CONFIGURE' });
    if (!ctx.actor.organizationId) throw new ValidationError('No organization context');
    const { id } = await params;
    const current = await prisma.retentionPolicy.findFirst({ where: { id, organizationId: ctx.actor.organizationId } });
    if (!current) throw new NotFoundError('Retention policy', id);
    const input = schema.parse(await request.json());
    const updated = await saveRetentionPolicy(ctx, {
      name: input.name ?? current.name,
      category: input.category ?? current.category,
      retentionMonths: input.retentionMonths ?? current.retentionMonths,
      action: input.action ?? current.action,
      legalBasis: input.legalBasis ?? current.legalBasis,
      isActive: input.isActive ?? current.isActive,
    });
    return ok({ data: updated }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
