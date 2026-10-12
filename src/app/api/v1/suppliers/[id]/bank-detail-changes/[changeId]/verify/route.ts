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

const verifySchema = z.object({ verificationNotes: z.string().min(10).max(1000) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string; changeId: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'SUPPLIERS', action: 'APPROVE' });
    if (!ctx.actor.organizationId) return apiError(new ValidationError('No organization context'), reqId);
    const key = request.headers.get('idempotency-key');
    if (!key) return apiError(new ValidationError('An Idempotency-Key header is required.'), reqId);
    const { id, changeId } = await params;
    const body = verifySchema.parse(await request.json());
    const change = await prisma.supplierBankDetailChangeRequest.findFirst({ where: { id: changeId, supplierId: id, organizationId: ctx.actor.organizationId }, select: { id: true, status: true, requestedById: true, verifierId: true, approverId: true, evidenceDocumentId: true } });
    if (!change) return apiError(new NotFoundError('Supplier bank detail change request', changeId), reqId);
    if (change.status !== 'PENDING' && change.status !== 'VERIFICATION_PENDING') return apiError(new ConflictError(`Cannot verify a change request in ${change.status} status.`), reqId);
    if (ctx.actor.userId === change.requestedById) return apiError(new ConflictError('The requester cannot verify their own bank detail change.'), reqId);
    if (change.approverId === ctx.actor.userId) return apiError(new ConflictError('The verifier and approver must be different people.'), reqId);
    if (!change.evidenceDocumentId) return apiError(new ValidationError('Evidence document is required before verification.'), reqId);
    const h = await headers();
    const ipAddress = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null;
    const userAgent = h.get('user-agent');
    const outcome = await runIdempotent({
      key, scope: `POST /api/v1/suppliers/${id}/bank-detail-changes/${changeId}/verify`, actorId: ctx.actor.userId, body,
      handler: async () => withAudit({ organizationId: ctx.actor.organizationId!, actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId }, async (tx) => {
        await lockSupplierBankDetailState(tx, ctx.actor.organizationId!, id);
        const currentRequest = await tx.supplierBankDetailChangeRequest.findFirst({ where: { id: changeId, organizationId: ctx.actor.organizationId!, supplierId: id, status: { in: ['PENDING', 'VERIFICATION_PENDING'] } }, select: { id: true, status: true, requestedById: true, approverId: true, evidenceDocumentId: true } });
        if (!currentRequest) throw new ConflictError('This bank detail change is no longer awaiting verification.');
        if (currentRequest.requestedById === ctx.actor.userId) throw new ConflictError('The requester cannot verify their own bank detail change.');
        if (currentRequest.approverId === ctx.actor.userId) throw new ConflictError('The verifier and approver must be different people.');
        if (!currentRequest.evidenceDocumentId) throw new ValidationError('Evidence document is required before verification.');
        const updated = await tx.supplierBankDetailChangeRequest.update({
          where: { id: changeId },
          data: { status: 'APPROVAL_PENDING', verifierId: ctx.actor.userId, verifiedAt: new Date(), verificationNotes: body.verificationNotes },
          select: { id: true, supplierId: true, status: true, requestedById: true, verifierId: true, verifiedAt: true, evidenceDocumentId: true },
        });
        await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, {
          action: 'SUPPLIER_BANK_DETAIL_CHANGE_VERIFIED', entityType: 'SUPPLIER_BANK_DETAIL_CHANGE_REQUEST', entityId: updated.id, entityLabel: id,
          description: `Verified bank detail change request ${updated.id}; awaiting a separate approver`,
          changes: { status: { from: currentRequest.status, to: 'APPROVAL_PENDING' }, verifierId: { from: null, to: ctx.actor.userId }, verifiedAt: { from: null, to: updated.verifiedAt?.toISOString() ?? null } },
          metadata: { verificationNotes: body.verificationNotes, evidenceDocumentId: updated.evidenceDocumentId },
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
