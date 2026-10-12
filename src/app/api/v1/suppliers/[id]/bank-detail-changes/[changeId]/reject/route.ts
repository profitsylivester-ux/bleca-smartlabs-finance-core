import { NextResponse } from 'next/server';
import { z } from 'zod';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/kernel/errors';
import { lockSupplierBankDetailState } from '@/lib/parties/security';

const rejectSchema = z.object({ reason: z.string().min(10).max(500) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string; changeId: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'SUPPLIERS', action: 'REJECT' });
    if (!ctx.actor.organizationId) return apiError(new ValidationError('No organization context'), reqId);
    const key = request.headers.get('idempotency-key');
    if (!key) return apiError(new ValidationError('An Idempotency-Key header is required.'), reqId);
    const { id, changeId } = await params;
    const body = rejectSchema.parse(await request.json());
    const change = await prisma.supplierBankDetailChangeRequest.findFirst({ where: { id: changeId, supplierId: id, organizationId: ctx.actor.organizationId }, select: { id: true, status: true, requestedById: true, verifierId: true } });
    if (!change) return apiError(new NotFoundError('Supplier bank detail change request', changeId), reqId);
    if (!['PENDING', 'VERIFICATION_PENDING', 'APPROVAL_PENDING'].includes(change.status)) return apiError(new ConflictError(`Cannot reject a change request in ${change.status} status.`), reqId);
    if (ctx.actor.userId === change.requestedById) return apiError(new ConflictError('The requester cannot reject their own bank detail change.'), reqId);
    const h = await headers();
    const ipAddress = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null;
    const userAgent = h.get('user-agent');
    const outcome = await runIdempotent({
      key, scope: `POST /api/v1/suppliers/${id}/bank-detail-changes/${changeId}/reject`, actorId: ctx.actor.userId, body,
      handler: async () => withAudit({ organizationId: ctx.actor.organizationId!, actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId }, async (tx) => {
        await lockSupplierBankDetailState(tx, ctx.actor.organizationId!, id);
        const currentRequest = await tx.supplierBankDetailChangeRequest.findFirst({ where: { id: changeId, organizationId: ctx.actor.organizationId!, supplierId: id, status: { in: ['PENDING', 'VERIFICATION_PENDING', 'APPROVAL_PENDING'] } }, select: { id: true, status: true, requestedById: true } });
        if (!currentRequest) throw new ConflictError('This bank detail change is no longer pending.');
        if (currentRequest.requestedById === ctx.actor.userId) throw new ConflictError('The requester cannot reject their own bank detail change.');
        const updated = await tx.supplierBankDetailChangeRequest.update({
          where: { id: changeId },
          data: { status: 'REJECTED', rejectedById: ctx.actor.userId, decidedAt: new Date(), decisionReason: body.reason },
          select: { id: true, supplierId: true, status: true, requestedById: true, verifierId: true, rejectedById: true, decidedAt: true, decisionReason: true },
        });
        await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, {
          action: 'SUPPLIER_BANK_DETAIL_CHANGE_REJECTED', entityType: 'SUPPLIER_BANK_DETAIL_CHANGE_REQUEST', entityId: updated.id, entityLabel: id,
          description: `Rejected supplier ${id} bank detail change request`,
          changes: { status: { from: currentRequest.status, to: 'REJECTED' }, rejectedById: { from: null, to: updated.rejectedById } },
          metadata: { requesterId: updated.requestedById, verifierId: updated.verifierId, reason: body.reason },
        }, { organizationId: ctx.actor.organizationId!, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId });
        return { status: 200, body: { data: updated } };
      }),
    });
    if (outcome.kind === 'REPLAYED') return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    return ok(outcome.result, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
