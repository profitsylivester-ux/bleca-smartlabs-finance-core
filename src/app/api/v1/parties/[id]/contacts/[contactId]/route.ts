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

const patchSchema = z.object({ fullName: z.string().min(1).max(160).optional(), title: z.string().max(100).nullable().optional(), email: z.string().email().nullable().optional(), phone: z.string().max(40).nullable().optional(), isPrimary: z.boolean().optional(), notes: z.string().max(1000).nullable().optional() }).refine((value) => Object.keys(value).length > 0, 'At least one field must be changed.');

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; contactId: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { id, contactId } = await params;
    await requirePartyAccess(ctx, id, 'EDIT');
    if (!ctx.actor.organizationId) return apiError(new ValidationError('No organization context'), reqId);
    const key = request.headers.get('idempotency-key');
    if (!key) return apiError(new ValidationError('An Idempotency-Key header is required.'), reqId);
    const body = patchSchema.parse(await request.json());
    const current = await prisma.contact.findFirst({ where: { id: contactId, partyId: id, isActive: true, deletedAt: null }, select: { id: true, fullName: true, isPrimary: true } });
    if (!current) return apiError(new NotFoundError('Contact', contactId), reqId);
    const h = await headers();
    const ipAddress = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null;
    const userAgent = h.get('user-agent');
    const outcome = await runIdempotent({ key, scope: `PATCH /api/v1/parties/${id}/contacts/${contactId}`, actorId: ctx.actor.userId, body, handler: async () => withAudit({ organizationId: ctx.actor.organizationId!, actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId }, async (tx) => {
      if (body.isPrimary) await tx.contact.updateMany({ where: { partyId: id, id: { not: contactId }, isPrimary: true, isActive: true }, data: { isPrimary: false } });
      const updated = await tx.contact.update({ where: { id: contactId }, data: body, select: { id: true, fullName: true, title: true, email: true, phone: true, isPrimary: true, updatedAt: true } });
      await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, { action: 'CONFIGURATION_CHANGES', entityType: 'CONTACT', entityId: updated.id, entityLabel: id, description: `Updated contact for party ${id}`, changes: { name: { from: current.fullName, to: updated.fullName }, isPrimary: { from: current.isPrimary, to: updated.isPrimary } } }, { organizationId: ctx.actor.organizationId!, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId });
      return { status: 200, body: { data: updated } };
    }) });
    if (outcome.kind === 'REPLAYED') return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    return ok(outcome.result, 200, reqId);
  } catch (error) { return apiError(error, reqId); }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string; contactId: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { id, contactId } = await params;
    await requirePartyAccess(ctx, id, 'EDIT');
    if (!ctx.actor.organizationId) return apiError(new ValidationError('No organization context'), reqId);
    const key = request.headers.get('idempotency-key');
    if (!key) return apiError(new ValidationError('An Idempotency-Key header is required.'), reqId);
    const current = await prisma.contact.findFirst({ where: { id: contactId, partyId: id, isActive: true, deletedAt: null }, select: { id: true, fullName: true } });
    if (!current) return apiError(new NotFoundError('Contact', contactId), reqId);
    const h = await headers();
    const ipAddress = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null;
    const userAgent = h.get('user-agent');
    const outcome = await runIdempotent({ key, scope: `DELETE /api/v1/parties/${id}/contacts/${contactId}`, actorId: ctx.actor.userId, body: { contactId }, handler: async () => withAudit({ organizationId: ctx.actor.organizationId!, actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId }, async (tx) => {
      const deletedAt = new Date();
      await tx.contact.update({ where: { id: contactId }, data: { isActive: false, deletedAt, isPrimary: false } });
      await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, { action: 'CONFIGURATION_CHANGES', entityType: 'CONTACT', entityId: contactId, entityLabel: id, description: `Soft-deleted contact ${current.fullName} from party ${id}`, changes: { deletedAt: { from: null, to: deletedAt.toISOString() } } }, { organizationId: ctx.actor.organizationId!, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId });
      return { status: 200, body: { data: { id: contactId, deletedAt } } };
    }) });
    if (outcome.kind === 'REPLAYED') return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    return ok(outcome.result, 200, reqId);
  } catch (error) { return apiError(error, reqId); }
}
