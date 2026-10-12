import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';
import { releaseLegalHold } from '@/lib/documents/service';

const schema = z.object({ reason: z.string().trim().min(5).max(4000) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { id } = await params;
    await authorize(ctx, { module: 'DOCUMENTS', action: 'ADMINISTER', entity: { type: 'DOCUMENT', id } });
    if (!ctx.actor.organizationId) throw new ValidationError('No organization context');
    const hold = await prisma.legalHold.findFirst({
      where: { organizationId: ctx.actor.organizationId, entityType: 'DOCUMENT', entityId: id, releasedAt: null },
      select: { id: true },
    });
    if (!hold) throw new NotFoundError('Active legal hold', id);
    const result = await releaseLegalHold(ctx, hold.id, schema.parse(await request.json()).reason);
    return ok({ data: result }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
