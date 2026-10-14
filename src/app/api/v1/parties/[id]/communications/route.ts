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
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';

const createSchema = z.object({
  channel: z.enum(['EMAIL', 'PHONE', 'MEETING', 'LETTER', 'OTHER']),
  direction: z.enum(['INBOUND', 'OUTBOUND', 'INTERNAL']).default('OUTBOUND'),
  subject: z.string().max(200).optional(),
  summary: z.string().min(1).max(4000),
  contactedAt: z.string().min(1).optional(),
  followUpAt: z.string().min(1).optional(),
});

async function authorizeParty(ctx: Awaited<ReturnType<typeof requireContext>>, partyId: string) {
  if (!ctx.actor.organizationId) throw new ValidationError('No organization context');
  const party = await prisma.party.findFirst({
    where: { id: partyId, organizationId: ctx.actor.organizationId, deletedAt: null },
    select: { id: true, customer: { select: { id: true } }, supplier: { select: { id: true } } },
  });
  if (!party) throw new NotFoundError('Party', partyId);
  if (party.customer) await authorize(ctx, { module: 'CUSTOMERS', action: 'VIEW' });
  if (party.supplier) await authorize(ctx, { module: 'SUPPLIERS', action: 'VIEW' });
  return party;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    const { id } = await params;
    const party = await authorizeParty(ctx, id);
    const data = await prisma.communicationLog.findMany({
      where: { organizationId: ctx.actor.organizationId!, partyId: party.id },
      orderBy: { contactedAt: 'desc' },
      select: { id: true, channel: true, direction: true, subject: true, summary: true, contactedAt: true, followUpAt: true, createdById: true, createdAt: true },
    });
    return ok({ data, count: data.length }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    if (!ctx.actor.organizationId) return apiError(new ValidationError('No organization context'), reqId);
    const { id } = await params;
    const party = await authorizeParty(ctx, id);
    if (party.customer) await authorize(ctx, { module: 'CUSTOMERS', action: 'CONFIGURE' });
    if (party.supplier) await authorize(ctx, { module: 'SUPPLIERS', action: 'CONFIGURE' });
    const key = request.headers.get('idempotency-key');
    if (!key) return apiError(new ValidationError('An Idempotency-Key header is required.'), reqId);
    const body = createSchema.parse(await request.json());
    const h = await headers();
    const ipAddress = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null;
    const userAgent = h.get('user-agent');
    const outcome = await runIdempotent({
      key, scope: `POST /api/v1/parties/${id}/communications`, actorId: ctx.actor.userId, body,
      handler: async () => withAudit({ organizationId: ctx.actor.organizationId!, actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId }, async (tx) => {
        const communication = await tx.communicationLog.create({
          data: {
            organizationId: ctx.actor.organizationId!, partyId: id,
            channel: body.channel, direction: body.direction, subject: body.subject, summary: body.summary,
            contactedAt: body.contactedAt ? new Date(body.contactedAt) : new Date(),
            followUpAt: body.followUpAt ? new Date(body.followUpAt) : null,
            createdById: ctx.actor.userId,
          },
          select: { id: true, partyId: true, channel: true, direction: true, subject: true, summary: true, contactedAt: true, followUpAt: true, createdAt: true },
        });
        await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, {
          action: 'COMMUNICATION_LOG_CREATED', entityType: 'COMMUNICATION_LOG', entityId: communication.id, entityLabel: id,
          description: `Recorded ${body.direction.toLowerCase()} ${body.channel.toLowerCase()} communication for party ${id}`,
          metadata: { channel: body.channel, direction: body.direction, followUpAt: communication.followUpAt?.toISOString() ?? null },
        }, { organizationId: ctx.actor.organizationId!, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId });
        return { status: 201, body: { data: communication } };
      }),
    });
    if (outcome.kind === 'REPLAYED') return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    return ok(outcome.result, 201, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

