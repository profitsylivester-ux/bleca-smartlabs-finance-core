import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { ValidationError, NotFoundError } from '@/lib/kernel/errors';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const orgId = ctx.actor.organizationId;
    if (!orgId) return apiError(new ValidationError('No organization context'), reqId);

    const key = request.headers.get('idempotency-key');
    if (!key) return apiError(new ValidationError('Idempotency-Key header required'), reqId);

    const { id } = await params;
    const change = await prisma.masterDataChangeRequest.findFirst({ where: { id, organizationId: orgId } });
    if (!change) return apiError(new NotFoundError('Change request', id), reqId);
    if (change.status !== 'APPROVED') return apiError(new ValidationError('Only approved changes can be restored'), reqId);

    await prisma.masterDataChangeRequest.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });

    return ok({ id, status: 'CANCELLED' });
  } catch (e) {
    return apiError(e, reqId);
  }
}
