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
import { bankAccountLast4, encryptBankAccountNumber, lockSupplierBankDetailState, notifyFinanceAndCeoOfBankChange } from '@/lib/parties/security';

const createSchema = z.object({
  bankName: z.string().min(1).max(160),
  accountHolderName: z.string().min(1).max(160),
  accountNumber: z.string().min(4).max(64).regex(/^[\d\s-]+$/),
  branchName: z.string().max(160).optional(),
  swiftCode: z.string().max(20).optional(),
  iban: z.string().max(34).optional(),
  currencyCode: z.string().length(3).toUpperCase().optional(),
  evidenceDocumentId: z.string().cuid(),
});

function safeSnapshot(value: unknown) {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const pick = (key: string) => typeof record[key] === 'string' ? record[key] : null;
  return {
    bankName: pick('bankName'),
    accountHolderName: pick('accountHolderName'),
    accountNumberLast4: pick('accountNumberLast4'),
    branchName: pick('branchName'),
    swiftCode: pick('swiftCode'),
    iban: pick('iban'),
    currencyCode: pick('currencyCode'),
  };
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'SUPPLIERS', action: 'VIEW' });
    if (!ctx.actor.organizationId) return apiError(new ValidationError('No organization context'), reqId);
    const { id } = await params;
    const supplier = await prisma.supplier.findFirst({ where: { id, organizationId: ctx.actor.organizationId, deletedAt: null }, select: { id: true } });
    if (!supplier) return apiError(new NotFoundError('Supplier', id), reqId);
    const [bankDetails, changes] = await Promise.all([
      prisma.supplierBankDetail.findMany({
        where: { supplierId: id }, orderBy: [{ isActive: 'desc' }, { effectiveFrom: 'desc' }],
        select: { id: true, bankName: true, accountHolderName: true, accountNumberLast4: true, branchName: true, swiftCode: true, iban: true, currencyCode: true, isPrimary: true, isActive: true, effectiveFrom: true, effectiveTo: true },
      }),
      prisma.supplierBankDetailChangeRequest.findMany({
        where: { supplierId: id }, orderBy: { requestedAt: 'desc' },
        select: { id: true, currentBankDetailId: true, previousValues: true, proposedValues: true, evidenceDocumentId: true, status: true, requestedById: true, verifierId: true, approverId: true, rejectedById: true, verificationNotes: true, decisionReason: true, requestedAt: true, verifiedAt: true, decidedAt: true, appliedBankDetailId: true },
      }),
    ]);
    return ok({ data: { bankDetails, changes: changes.map((change) => ({ ...change, previousValues: safeSnapshot(change.previousValues), proposedValues: safeSnapshot(change.proposedValues) })) } }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'SUPPLIERS', action: 'EDIT' });
    if (!ctx.actor.organizationId) return apiError(new ValidationError('No organization context'), reqId);
    const key = request.headers.get('idempotency-key');
    if (!key) return apiError(new ValidationError('An Idempotency-Key header is required.'), reqId);
    const { id } = await params;
    const body = createSchema.parse(await request.json());
    const supplier = await prisma.supplier.findFirst({
      where: { id, organizationId: ctx.actor.organizationId, deletedAt: null },
      select: { id: true, status: true, masterDataStatus: true },
    });
    if (!supplier) return apiError(new NotFoundError('Supplier', id), reqId);
    if (supplier.status !== 'ACTIVE' || supplier.masterDataStatus !== 'ACTIVE') return apiError(new ConflictError('Bank details can only be changed for an active, approved supplier.'), reqId);
    const pending = await prisma.supplierBankDetailChangeRequest.findFirst({
      where: { supplierId: id, organizationId: ctx.actor.organizationId, status: { in: ['PENDING', 'VERIFICATION_PENDING', 'APPROVAL_PENDING'] } },
      select: { id: true },
    });
    if (pending) return apiError(new ConflictError('A supplier bank detail change is already in progress.', { changeRequestId: pending.id }), reqId);

    const h = await headers();
    const ipAddress = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null;
    const userAgent = h.get('user-agent');
    const outcome = await runIdempotent({
      key, scope: `POST /api/v1/suppliers/${id}/bank-details`, actorId: ctx.actor.userId, body,
      handler: async () => withAudit({ organizationId: ctx.actor.organizationId!, actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId }, async (tx) => {
        await lockSupplierBankDetailState(tx, ctx.actor.organizationId!, id);
        const pendingInTransaction = await tx.supplierBankDetailChangeRequest.findFirst({
          where: { organizationId: ctx.actor.organizationId!, supplierId: id, status: { in: ['PENDING', 'VERIFICATION_PENDING', 'APPROVAL_PENDING'] } },
          select: { id: true },
        });
        if (pendingInTransaction) throw new ConflictError('A supplier bank detail change is already in progress.', { changeRequestId: pendingInTransaction.id });
        const current = await tx.supplierBankDetail.findFirst({ where: { supplierId: id, isActive: true, isPrimary: true }, orderBy: { effectiveFrom: 'desc' } });
        const previousValues: Prisma.InputJsonObject = current ? {
          bankDetailId: current.id,
          bankName: current.bankName,
          accountHolderName: current.accountHolderName,
          accountNumberEncrypted: current.accountNumberEncrypted,
          accountNumberLast4: current.accountNumberLast4,
          branchName: current.branchName,
          swiftCode: current.swiftCode,
          iban: current.iban,
          currencyCode: current.currencyCode,
          isPrimary: current.isPrimary,
          isActive: current.isActive,
        } : {};
        const proposedValues: Prisma.InputJsonObject = {
          bankName: body.bankName,
          accountHolderName: body.accountHolderName,
          accountNumberEncrypted: encryptBankAccountNumber(body.accountNumber),
          accountNumberLast4: bankAccountLast4(body.accountNumber),
          branchName: body.branchName ?? null,
          swiftCode: body.swiftCode ?? null,
          iban: body.iban ?? null,
          currencyCode: body.currencyCode ?? null,
        };
        const change = await tx.supplierBankDetailChangeRequest.create({
          data: {
            organizationId: ctx.actor.organizationId!,
            supplierId: id,
            currentBankDetailId: current?.id ?? null,
            previousValues,
            proposedValues,
            evidenceDocumentId: body.evidenceDocumentId,
            status: 'PENDING',
            requestedById: ctx.actor.userId,
          },
          select: { id: true, supplierId: true, currentBankDetailId: true, previousValues: true, evidenceDocumentId: true, status: true, requestedById: true, requestedAt: true },
        });
        await notifyFinanceAndCeoOfBankChange(tx, ctx.actor.organizationId!, id, change.id);
        await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, {
          action: 'SUPPLIER_BANK_DETAIL_CHANGE_REQUESTED', entityType: 'SUPPLIER_BANK_DETAIL_CHANGE_REQUEST', entityId: change.id, entityLabel: id,
          description: `Requested supplier ${id} bank detail change; supplier payments are now blocked`,
          changes: { status: { from: null, to: 'PENDING' }, currentBankDetailId: { from: null, to: current?.id ?? null } },
          metadata: { evidenceDocumentId: change.evidenceDocumentId, previousValues: safeSnapshot(change.previousValues), proposedValues: safeSnapshot(proposedValues) },
        }, { organizationId: ctx.actor.organizationId!, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId });
        return { status: 201, body: { data: { ...change, previousValues: safeSnapshot(change.previousValues), proposedValues: safeSnapshot(proposedValues) } } };
      }),
    });
    if (outcome.kind === 'REPLAYED') return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    return ok(outcome.result, 201, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
