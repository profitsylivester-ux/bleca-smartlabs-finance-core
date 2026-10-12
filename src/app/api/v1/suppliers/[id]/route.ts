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
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';
import { createPartyMasterDataRequest } from '@/lib/parties/security';

const patchSchema = z.object({
  status: z.enum(['PROSPECT', 'ACTIVE', 'INACTIVE', 'BLOCKED']).optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  paymentCurrencyCode: z.string().length(3).toUpperCase().nullable().optional(),
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  performanceRating: z.number().min(0).max(5).nullable().optional(),
  deliveryRating: z.number().min(0).max(5).nullable().optional(),
  qualityRating: z.number().min(0).max(5).nullable().optional(),
  party: z.object({
    displayName: z.string().min(1).max(200).optional(),
    legalName: z.string().max(200).nullable().optional(),
    firstName: z.string().max(100).nullable().optional(),
    lastName: z.string().max(100).nullable().optional(),
    taxIdentifier: z.string().max(100).nullable().optional(),
    registrationNumber: z.string().max(100).nullable().optional(),
    email: z.string().email().nullable().optional(),
    phone: z.string().max(40).nullable().optional(),
    website: z.string().url().nullable().optional(),
  }).optional(),
  reason: z.string().min(10).max(500),
}).refine((value) => Object.keys(value).some((key) => key !== 'reason'), 'At least one field must be changed.');

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'SUPPLIERS', action: 'VIEW' });
    if (!ctx.actor.organizationId) return apiError(new ValidationError('No organization context'), reqId);
    const { id } = await params;
    const supplier = await prisma.supplier.findFirst({
      where: { id, organizationId: ctx.actor.organizationId, deletedAt: null },
      include: {
        party: { include: { contacts: { orderBy: [{ isPrimary: 'desc' }, { fullName: 'asc' }] }, addresses: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] } } },
        bankDetails: { where: { isActive: true }, orderBy: [{ isPrimary: 'desc' }, { effectiveFrom: 'desc' }], select: {
          id: true, bankName: true, accountHolderName: true, accountNumberLast4: true, branchName: true,
          swiftCode: true, iban: true, currencyCode: true, isPrimary: true, effectiveFrom: true,
        } },
        productsServices: { include: { productService: { select: { id: true, code: true, name: true, type: true } } } },
        taxObligations: true,
      },
    });
    if (!supplier) return apiError(new NotFoundError('Supplier', id), reqId);
    const versions = await prisma.masterDataVersion.findMany({
      where: { entityType: 'SUPPLIER', entityId: id }, orderBy: { versionNumber: 'desc' },
      select: { id: true, versionNumber: true, snapshot: true, changedFields: true, effectiveFrom: true, createdAt: true },
    });
    return ok({ data: supplier, versions }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'SUPPLIERS', action: 'EDIT' });
    if (!ctx.actor.organizationId) return apiError(new ValidationError('No organization context'), reqId);
    const key = request.headers.get('idempotency-key');
    if (!key) return apiError(new ValidationError('An Idempotency-Key header is required.'), reqId);
    const { id } = await params;
    const body = patchSchema.parse(await request.json());
    const supplier = await prisma.supplier.findFirst({ where: { id, organizationId: ctx.actor.organizationId, deletedAt: null }, select: { id: true, status: true } });
    if (!supplier) return apiError(new NotFoundError('Supplier', id), reqId);
    const proposedChanges: Prisma.InputJsonObject = {
      masterDataStatus: 'ACTIVE',
      updatedById: ctx.actor.userId,
      ...(body.status ? { status: body.status } : {}),
      ...(body.paymentTermsDays !== undefined ? { paymentTermsDays: body.paymentTermsDays } : {}),
      ...(body.paymentCurrencyCode !== undefined ? { paymentCurrencyCode: body.paymentCurrencyCode } : {}),
      ...(body.riskLevel ? { riskLevel: body.riskLevel } : {}),
      ...(body.performanceRating !== undefined ? { performanceRating: body.performanceRating } : {}),
      ...(body.deliveryRating !== undefined ? { deliveryRating: body.deliveryRating } : {}),
      ...(body.qualityRating !== undefined ? { qualityRating: body.qualityRating } : {}),
      ...(body.party ? { party: { update: body.party } as Prisma.InputJsonObject } : {}),
    };
    const h = await headers();
    const ipAddress = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null;
    const userAgent = h.get('user-agent');
    const outcome = await runIdempotent({
      key, scope: `PATCH /api/v1/suppliers/${id}`, actorId: ctx.actor.userId, body,
      handler: async () => withAudit({ organizationId: ctx.actor.organizationId!, actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId }, async (tx) => {
        const change = await createPartyMasterDataRequest(tx, {
          organizationId: ctx.actor.organizationId!, entityType: 'SUPPLIER', entityId: id,
          proposedChanges, reason: body.reason, requestedById: ctx.actor.userId,
        });
        await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, {
          action: 'SUPPLIER_UPDATED', entityType: 'SUPPLIER', entityId: id,
          description: `Requested an approved update to supplier ${id}`,
          changes: { masterDataStatus: { from: 'ACTIVE', to: 'PENDING_APPROVAL' } },
          metadata: { changeRequestId: change.id, requestedFields: Object.keys(proposedChanges) },
        }, { organizationId: ctx.actor.organizationId!, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId });
        return { status: 202, body: { data: { supplierId: id, changeRequestId: change.id, status: change.status } } };
      }),
    });
    if (outcome.kind === 'REPLAYED') return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    return ok(outcome.result, 202, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'SUPPLIERS', action: 'EDIT' });
    if (!ctx.actor.organizationId) return apiError(new ValidationError('No organization context'), reqId);
    const key = request.headers.get('idempotency-key');
    if (!key) return apiError(new ValidationError('An Idempotency-Key header is required.'), reqId);
    const { id } = await params;
    const supplier = await prisma.supplier.findFirst({ where: { id, organizationId: ctx.actor.organizationId, deletedAt: null }, select: { id: true, partyId: true, status: true } });
    if (!supplier) return apiError(new NotFoundError('Supplier', id), reqId);
    const h = await headers();
    const ipAddress = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null;
    const userAgent = h.get('user-agent');
    const outcome = await runIdempotent({
      key, scope: `DELETE /api/v1/suppliers/${id}`, actorId: ctx.actor.userId, body: { id },
      handler: async () => withAudit({ organizationId: ctx.actor.organizationId!, actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId }, async (tx) => {
        const deletedAt = new Date();
        await tx.supplier.update({ where: { id }, data: { status: 'INACTIVE', deletedAt, updatedById: ctx.actor.userId } });
        const party = await tx.supplier.findUniqueOrThrow({ where: { id }, select: { partyId: true } });
        await tx.party.update({ where: { id: party.partyId }, data: { isActive: false, deletedAt, updatedById: ctx.actor.userId } });
        await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, {
          action: 'SUPPLIER_DEACTIVATED', entityType: 'SUPPLIER', entityId: id,
          description: `Soft-deleted supplier ${id}`, changes: { deletedAt: { from: null, to: deletedAt.toISOString() }, status: { from: supplier.status, to: 'INACTIVE' } },
        }, { organizationId: ctx.actor.organizationId!, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId });
        return { status: 200, body: { data: { id, status: 'INACTIVE', deletedAt } } };
      }),
    });
    if (outcome.kind === 'REPLAYED') return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    return ok(outcome.result, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
