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
  creditLimit: z.number().min(0).optional(),
  currencyCode: z.string().length(3).toUpperCase().optional(),
  relationshipOwnerId: z.string().cuid().nullable().optional(),
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  badDebtAmount: z.number().min(0).optional(),
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
    await authorize(ctx, { module: 'CUSTOMERS', action: 'VIEW' });
    if (!ctx.actor.organizationId) return apiError(new ValidationError('No organization context'), reqId);
    const { id } = await params;
    const customer = await prisma.customer.findFirst({
      where: { id, organizationId: ctx.actor.organizationId, deletedAt: null },
      include: {
        party: { include: { contacts: { orderBy: [{ isPrimary: 'desc' }, { fullName: 'asc' }] }, addresses: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] } } },
        creditHolds: { orderBy: { heldAt: 'desc' } },
        receivables: { where: { status: { in: ['OPEN', 'PARTIALLY_PAID'] } }, orderBy: { dueAt: 'asc' } },
      },
    });
    if (!customer) return apiError(new NotFoundError('Customer', id), reqId);
    const versions = await prisma.masterDataVersion.findMany({
      where: { entityType: 'CUSTOMER', entityId: id },
      orderBy: { versionNumber: 'desc' },
      select: { id: true, versionNumber: true, snapshot: true, changedFields: true, effectiveFrom: true, createdAt: true },
    });
    const outstanding = customer.receivables.reduce((sum, invoice) => invoice.currencyCode === customer.currencyCode ? sum.plus(invoice.outstandingAmount) : sum, new Prisma.Decimal(0));
    return ok({ data: { ...customer, outstandingBalance: outstanding.toString() }, versions }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'CUSTOMERS', action: 'EDIT' });
    if (!ctx.actor.organizationId) return apiError(new ValidationError('No organization context'), reqId);
    const key = request.headers.get('idempotency-key');
    if (!key) return apiError(new ValidationError('An Idempotency-Key header is required.'), reqId);
    const { id } = await params;
    const body = patchSchema.parse(await request.json());
    const customer = await prisma.customer.findFirst({ where: { id, organizationId: ctx.actor.organizationId, deletedAt: null }, select: { id: true, partyId: true, status: true } });
    if (!customer) return apiError(new NotFoundError('Customer', id), reqId);
    if (customer.status === 'CREDIT_HOLD' && body.status === 'ACTIVE') {
      return apiError(new ValidationError('Use the credit hold release workflow to reactivate a customer on hold.'), reqId);
    }
    if (body.relationshipOwnerId) {
      const owner = await prisma.user.findFirst({ where: { id: body.relationshipOwnerId, isActive: true, organizationMemberships: { some: { organizationId: ctx.actor.organizationId } } }, select: { id: true } });
      if (!owner) return apiError(new ValidationError('Relationship owner must be an active member of this organization.'), reqId);
    }
    const h = await headers();
    const ipAddress = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null;
    const userAgent = h.get('user-agent');
    const proposedChanges: Prisma.InputJsonObject = {
      masterDataStatus: 'ACTIVE',
      updatedById: ctx.actor.userId,
      ...(body.status ? { status: body.status } : {}),
      ...(body.paymentTermsDays !== undefined ? { paymentTermsDays: body.paymentTermsDays } : {}),
      ...(body.creditLimit !== undefined ? { creditLimit: body.creditLimit } : {}),
      ...(body.currencyCode ? { currencyCode: body.currencyCode } : {}),
      ...(body.relationshipOwnerId !== undefined ? { relationshipOwnerId: body.relationshipOwnerId } : {}),
      ...(body.riskLevel ? { riskLevel: body.riskLevel } : {}),
      ...(body.badDebtAmount !== undefined ? { badDebtAmount: body.badDebtAmount } : {}),
      ...(body.party ? { party: { update: body.party } as Prisma.InputJsonObject } : {}),
    };
    const outcome = await runIdempotent({
      key, scope: `PATCH /api/v1/customers/${id}`, actorId: ctx.actor.userId, body,
      handler: async () => withAudit({ organizationId: ctx.actor.organizationId!, actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId }, async (tx) => {
        const change = await createPartyMasterDataRequest(tx, {
          organizationId: ctx.actor.organizationId!, entityType: 'CUSTOMER', entityId: id,
          proposedChanges, reason: body.reason, requestedById: ctx.actor.userId,
        });
        await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, {
          action: 'CUSTOMER_UPDATED', entityType: 'CUSTOMER', entityId: id,
          description: `Requested an approved update to customer ${id}`,
          changes: { masterDataStatus: { from: 'ACTIVE', to: 'PENDING_APPROVAL' } },
          metadata: { changeRequestId: change.id, requestedFields: Object.keys(proposedChanges) },
        }, { organizationId: ctx.actor.organizationId!, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId });
        return { status: 202, body: { data: { customerId: id, changeRequestId: change.id, status: change.status } } };
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
    await authorize(ctx, { module: 'CUSTOMERS', action: 'EDIT' });
    if (!ctx.actor.organizationId) return apiError(new ValidationError('No organization context'), reqId);
    const key = request.headers.get('idempotency-key');
    if (!key) return apiError(new ValidationError('An Idempotency-Key header is required.'), reqId);
    const { id } = await params;
    const customer = await prisma.customer.findFirst({ where: { id, organizationId: ctx.actor.organizationId, deletedAt: null }, select: { id: true, partyId: true, status: true } });
    if (!customer) return apiError(new NotFoundError('Customer', id), reqId);
    const h = await headers();
    const ipAddress = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null;
    const userAgent = h.get('user-agent');
    const outcome = await runIdempotent({
      key, scope: `DELETE /api/v1/customers/${id}`, actorId: ctx.actor.userId, body: { id },
      handler: async () => withAudit({ organizationId: ctx.actor.organizationId!, actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId }, async (tx) => {
        const deletedAt = new Date();
        await tx.customer.update({ where: { id }, data: { status: 'INACTIVE', deletedAt, updatedById: ctx.actor.userId } });
        await tx.party.update({ where: { id: customer.partyId }, data: { isActive: false, deletedAt, updatedById: ctx.actor.userId } });
        await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, {
          action: 'CUSTOMER_DEACTIVATED', entityType: 'CUSTOMER', entityId: id,
          description: `Soft-deleted customer ${id}`, changes: { deletedAt: { from: null, to: deletedAt.toISOString() }, status: { from: customer.status, to: 'INACTIVE' } },
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
