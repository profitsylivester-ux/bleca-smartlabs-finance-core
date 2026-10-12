import { NextResponse } from 'next/server';
import { z } from 'zod';
import { headers } from 'next/headers';
import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/kernel/errors';
import { lockSupplierBankDetailState } from '@/lib/parties/security';

const approveSchema = z.object({ reason: z.string().min(10).max(500) });
const proposalSchema = z.object({
  bankName: z.string(),
  accountHolderName: z.string(),
  accountNumberEncrypted: z.string(),
  accountNumberLast4: z.string().length(4),
  branchName: z.string().nullable(),
  swiftCode: z.string().nullable(),
  iban: z.string().nullable(),
  currencyCode: z.string().length(3).nullable(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string; changeId: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'SUPPLIERS', action: 'APPROVE' });
    if (!ctx.actor.organizationId) return apiError(new ValidationError('No organization context'), reqId);
    const key = request.headers.get('idempotency-key');
    if (!key) return apiError(new ValidationError('An Idempotency-Key header is required.'), reqId);
    const { id, changeId } = await params;
    const body = approveSchema.parse(await request.json());
    const change = await prisma.supplierBankDetailChangeRequest.findFirst({
      where: { id: changeId, supplierId: id, organizationId: ctx.actor.organizationId },
      select: { id: true, status: true, currentBankDetailId: true, previousValues: true, proposedValues: true, evidenceDocumentId: true, requestedById: true, verifierId: true, approverId: true },
    });
    if (!change) return apiError(new NotFoundError('Supplier bank detail change request', changeId), reqId);
    if (change.status !== 'APPROVAL_PENDING') return apiError(new ConflictError(`Cannot approve a change request in ${change.status} status.`), reqId);
    if (!change.verifierId) return apiError(new ConflictError('Bank detail change must be independently verified before approval.'), reqId);
    if (ctx.actor.userId === change.requestedById || ctx.actor.userId === change.verifierId) {
      return apiError(new ConflictError('Requester, verifier, and approver must be three different people.'), reqId);
    }
    if (!change.evidenceDocumentId) return apiError(new ValidationError('Evidence document is required before approval.'), reqId);
    const proposal = proposalSchema.parse(change.proposedValues);
    const h = await headers();
    const ipAddress = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null;
    const userAgent = h.get('user-agent');
    const outcome = await runIdempotent({
      key, scope: `POST /api/v1/suppliers/${id}/bank-detail-changes/${changeId}/approve`, actorId: ctx.actor.userId, body,
      handler: async () => withAudit({ organizationId: ctx.actor.organizationId!, actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId }, async (tx) => {
        await lockSupplierBankDetailState(tx, ctx.actor.organizationId!, id);
        const currentRequest = await tx.supplierBankDetailChangeRequest.findFirst({
          where: { id: changeId, organizationId: ctx.actor.organizationId!, supplierId: id, status: 'APPROVAL_PENDING' },
          select: { id: true, verifierId: true, requestedById: true },
        });
        if (!currentRequest) throw new ConflictError('This bank detail change is no longer awaiting approval.');
        if (!currentRequest.verifierId || currentRequest.requestedById === ctx.actor.userId || currentRequest.verifierId === ctx.actor.userId) {
          throw new ConflictError('Requester, verifier, and approver must be three different people.');
        }
        const current = await tx.supplierBankDetail.findFirst({ where: { supplierId: id, isActive: true, isPrimary: true }, select: { id: true } });
        if ((current?.id ?? null) !== change.currentBankDetailId) {
          throw new ConflictError('The active supplier bank details changed after this request was created. Create a new request from the current values.', { requestedBankDetailId: change.currentBankDetailId, activeBankDetailId: current?.id ?? null });
        }
        const decidedAt = new Date();
        if (current) {
          await tx.supplierBankDetail.update({ where: { id: current.id }, data: { isActive: false, isPrimary: false, effectiveTo: decidedAt } });
        }
        const newBankDetail = await tx.supplierBankDetail.create({
          data: {
            supplierId: id,
            bankName: proposal.bankName,
            accountHolderName: proposal.accountHolderName,
            accountNumberEncrypted: proposal.accountNumberEncrypted,
            accountNumberLast4: proposal.accountNumberLast4,
            branchName: proposal.branchName,
            swiftCode: proposal.swiftCode,
            iban: proposal.iban,
            currencyCode: proposal.currencyCode,
            isPrimary: true,
            isActive: true,
            effectiveFrom: decidedAt,
          },
          select: { id: true, bankName: true, accountHolderName: true, accountNumberLast4: true, currencyCode: true, isPrimary: true, isActive: true, effectiveFrom: true },
        });
        const updated = await tx.supplierBankDetailChangeRequest.update({
          where: { id: changeId },
          data: { status: 'APPROVED', approverId: ctx.actor.userId, decidedAt, decisionReason: body.reason, appliedBankDetailId: newBankDetail.id },
          select: { id: true, supplierId: true, status: true, requestedById: true, verifierId: true, approverId: true, evidenceDocumentId: true, decidedAt: true, appliedBankDetailId: true },
        });
        await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, {
          action: 'SUPPLIER_BANK_DETAIL_CHANGE_APPROVED', entityType: 'SUPPLIER_BANK_DETAIL_CHANGE_REQUEST', entityId: updated.id, entityLabel: id,
          description: `Approved supplier ${id} bank detail change and activated a new primary account`,
          changes: { status: { from: 'APPROVAL_PENDING', to: 'APPROVED' }, appliedBankDetailId: { from: null, to: newBankDetail.id } },
          metadata: { requesterId: updated.requestedById, verifierId: updated.verifierId, approverId: updated.approverId, reason: body.reason, previousValues: change.previousValues as Prisma.InputJsonValue },
        }, { organizationId: ctx.actor.organizationId!, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId });
        return { status: 200, body: { data: { ...updated, bankDetail: newBankDetail } } };
      }),
    });
    if (outcome.kind === 'REPLAYED') return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    return ok(outcome.result, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
