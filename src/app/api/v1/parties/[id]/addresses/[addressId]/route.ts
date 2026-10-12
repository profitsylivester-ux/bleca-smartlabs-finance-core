import { NextResponse } from 'next/server';
import { z } from 'zod';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';
import { requirePartyAccess } from '@/lib/parties/access';

const patchSchema = z.object({ type: z.enum(['REGISTERED', 'BILLING', 'SHIPPING', 'OTHER']).optional(), label: z.string().max(100).nullable().optional(), addressLine1: z.string().min(1).max(200).optional(), addressLine2: z.string().max(200).nullable().optional(), city: z.string().max(100).nullable().optional(), region: z.string().max(100).nullable().optional(), postalCode: z.string().max(30).nullable().optional(), countryCode: z.string().length(2).toUpperCase().optional(), isPrimary: z.boolean().optional() }).refine((value) => Object.keys(value).length > 0, 'At least one field must be changed.');

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; addressId: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { id, addressId } = await params;
    await requirePartyAccess(ctx, id, 'EDIT');
    if (!ctx.actor.organizationId) return apiError(new ValidationError('No organization context'), reqId);
    const key = request.headers.get('idempotency-key');
    if (!key) return apiError(new ValidationError('An Idempotency-Key header is required.'), reqId);
    const body = patchSchema.parse(await request.json());
    const current = await prisma.partyAddress.findFirst({ where: { id: addressId, partyId: id, isActive: true, deletedAt: null }, select: { id: true, addressLine1: true, isPrimary: true } });
    if (!current) return apiError(new NotFoundError('Party address', addressId), reqId);
    const h = await headers();
    const ipAddress = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null;
    const userAgent = h.get('user-agent');
    const outcome = await runIdempotent({ key, scope: `PATCH /api/v1/parties/${id}/addresses/${addressId}`, actorId: ctx.actor.userId, body, handler: async () => withAudit({ organizationId: ctx.actor.organizationId!, actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId }, async (tx) => {
      if (body.isPrimary) await tx.partyAddress.updateMany({ where: { partyId: id, id: { not: addressId }, isPrimary: true, isActive: true }, data: { isPrimary: false } });
      const updated = await tx.partyAddress.update({ where: { id: addressId }, data: body, select: { id: true, type: true, addressLine1: true, city: true, countryCode: true, isPrimary: true } });
      await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, { action: 'CONFIGURATION_CHANGES', entityType: 'PARTY_ADDRESS', entityId: updated.id, entityLabel: id, description: `Updated address on party ${id}`, changes: { addressLine1: { from: current.addressLine1, to: updated.addressLine1 }, isPrimary: { from: current.isPrimary, to: updated.isPrimary } } }, { organizationId: ctx.actor.organizationId!, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId });
      return { status: 200, body: { data: updated } };
    }) });
    if (outcome.kind === 'REPLAYED') return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    return ok(outcome.result, 200, reqId);
  } catch (error) { return apiError(error, reqId); }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string; addressId: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { id, addressId } = await params;
    await requirePartyAccess(ctx, id, 'EDIT');
    if (!ctx.actor.organizationId) return apiError(new ValidationError('No organization context'), reqId);
    const key = request.headers.get('idempotency-key');
    if (!key) return apiError(new ValidationError('An Idempotency-Key header is required.'), reqId);
    const current = await prisma.partyAddress.findFirst({ where: { id: addressId, partyId: id, isActive: true, deletedAt: null }, select: { id: true, addressLine1: true } });
    if (!current) return apiError(new NotFoundError('Party address', addressId), reqId);
    const h = await headers();
    const ipAddress = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null;
    const userAgent = h.get('user-agent');
    const outcome = await runIdempotent({ key, scope: `DELETE /api/v1/parties/${id}/addresses/${addressId}`, actorId: ctx.actor.userId, body: { addressId }, handler: async () => withAudit({ organizationId: ctx.actor.organizationId!, actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId }, async (tx) => {
      const deletedAt = new Date();
      await tx.partyAddress.update({ where: { id: addressId }, data: { isActive: false, deletedAt, isPrimary: false } });
      await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, { action: 'CONFIGURATION_CHANGES', entityType: 'PARTY_ADDRESS', entityId: addressId, entityLabel: id, description: `Soft-deleted address ${current.addressLine1} from party ${id}`, changes: { deletedAt: { from: null, to: deletedAt.toISOString() } } }, { organizationId: ctx.actor.organizationId!, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId });
      return { status: 200, body: { data: { id: addressId, deletedAt } } };
    }) });
    if (outcome.kind === 'REPLAYED') return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    return ok(outcome.result, 200, reqId);
  } catch (error) { return apiError(error, reqId); }
}
