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

const addressSchema = z.object({ type: z.enum(['REGISTERED', 'BILLING', 'SHIPPING', 'OTHER']), label: z.string().max(100).optional(), addressLine1: z.string().min(1).max(200), addressLine2: z.string().max(200).optional(), city: z.string().max(100).optional(), region: z.string().max(100).optional(), postalCode: z.string().max(30).optional(), countryCode: z.string().length(2).toUpperCase(), isPrimary: z.boolean().default(false) });

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { id } = await params;
    await requirePartyAccess(ctx, id, 'VIEW');
    const data = await prisma.partyAddress.findMany({ where: { partyId: id, isActive: true, deletedAt: null }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] });
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
    const body = addressSchema.parse(await request.json());
    const h = await headers();
    const ipAddress = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null;
    const userAgent = h.get('user-agent');
    const outcome = await runIdempotent({ key, scope: `POST /api/v1/parties/${id}/addresses`, actorId: ctx.actor.userId, body, handler: async () => withAudit({ organizationId: ctx.actor.organizationId!, actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId }, async (tx) => {
      if (body.isPrimary) await tx.partyAddress.updateMany({ where: { partyId: id, isPrimary: true, isActive: true }, data: { isPrimary: false } });
      const address = await tx.partyAddress.create({ data: { partyId: id, ...body }, select: { id: true, partyId: true, type: true, addressLine1: true, city: true, countryCode: true, isPrimary: true, createdAt: true } });
      await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, { action: 'CONFIGURATION_CHANGES', entityType: 'PARTY_ADDRESS', entityId: address.id, entityLabel: id, description: `Added ${address.type.toLowerCase()} address to party ${id}`, changes: { addressLine1: { from: null, to: address.addressLine1 }, isPrimary: { from: null, to: address.isPrimary } } }, { organizationId: ctx.actor.organizationId!, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId });
      return { status: 201, body: { data: address } };
    }) });
    if (outcome.kind === 'REPLAYED') return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    return ok(outcome.result, 201, reqId);
  } catch (error) { return apiError(error, reqId); }
}
