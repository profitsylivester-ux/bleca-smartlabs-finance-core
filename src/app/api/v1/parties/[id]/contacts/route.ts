import { NextResponse } from 'next/server';
import { z } from 'zod';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { ValidationError } from '@/lib/kernel/errors';
import { requirePartyAccess } from '@/lib/parties/access';

const createSchema = z.object({ fullName: z.string().min(1).max(160), title: z.string().max(100).optional(), email: z.string().email().optional(), phone: z.string().max(40).optional(), isPrimary: z.boolean().default(false), notes: z.string().max(1000).optional() });

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { id } = await params;
    await requirePartyAccess(ctx, id, 'VIEW');
    const data = await prisma.contact.findMany({ where: { partyId: id, isActive: true, deletedAt: null }, orderBy: [{ isPrimary: 'desc' }, { fullName: 'asc' }] });
    return ok({ data, count: data.length }, 200, reqId);
  } catch (error) { return apiError(error, reqId); }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { id } = await params;
    await requirePartyAccess(ctx, id, 'EDIT');
    if (!ctx.actor.organizationId) return apiError(new ValidationError('No organization context'), reqId);
    const key = request.headers.get('idempotency-key');
    if (!key) return apiError(new ValidationError('An Idempotency-Key header is required.'), reqId);
    const body = createSchema.parse(await request.json());
    const h = await headers();
    const ipAddress = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null;
    const userAgent = h.get('user-agent');
    const outcome = await runIdempotent({ key, scope: `POST /api/v1/parties/${id}/contacts`, actorId: ctx.actor.userId, body, handler: async () => withAudit({ organizationId: ctx.actor.organizationId!, actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId }, async (tx) => {
      if (body.isPrimary) await tx.contact.updateMany({ where: { partyId: id, isPrimary: true, isActive: true }, data: { isPrimary: false } });
      const contact = await tx.contact.create({ data: { partyId: id, fullName: body.fullName, title: body.title, email: body.email, phone: body.phone, isPrimary: body.isPrimary, notes: body.notes }, select: { id: true, partyId: true, fullName: true, title: true, email: true, phone: true, isPrimary: true, createdAt: true } });
      await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, { action: 'CONFIGURATION_CHANGES', entityType: 'CONTACT', entityId: contact.id, entityLabel: id, description: `Added contact ${contact.fullName} to party ${id}`, changes: { contact: { from: null, to: contact.fullName }, isPrimary: { from: null, to: contact.isPrimary } } }, { organizationId: ctx.actor.organizationId!, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId });
      return { status: 201, body: { data: contact } };
    }) });
    if (outcome.kind === 'REPLAYED') return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    return ok(outcome.result, 201, reqId);
  } catch (error) { return apiError(error, reqId); }
}
