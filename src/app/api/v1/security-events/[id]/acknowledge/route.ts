import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';

const acknowledgeSchema = z.object({
  note: z.string().min(1).max(1000),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'AUDIT_TRAIL', action: 'APPROVE' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const { id } = await params;

    const key = request.headers.get('idempotency-key');
    if (!key) {
      return apiError(
        new ValidationError('An Idempotency-Key header is required on this endpoint.'),
        reqId,
      );
    }

    const body = acknowledgeSchema.parse(await request.json());

    const event = await prisma.securityEvent.findUnique({
      where: { id },
      select: { id: true, organizationId: true, acknowledgedAt: true, type: true, severity: true },
    });

    if (!event || event.organizationId !== ctx.actor.organizationId) {
      return apiError(new NotFoundError('Security event', id), reqId);
    }

    if (event.acknowledgedAt) {
      return apiError(new ValidationError('Event already acknowledged'), reqId);
    }

    const h = await headers();
    const net = {
      ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
      userAgent: h.get('user-agent'),
      requestId: reqId,
      sessionId: ctx.actor.sessionId,
    };

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/security-events/${id}/acknowledge`,
      actorId: ctx.actor.userId,
      body,
      handler: async () =>
        withAudit(
          {
            organizationId: ctx.actor.organizationId!,
            actor: {
              id: ctx.actor.userId,
              name: ctx.actor.fullName,
              roleCodes: ctx.actor.roleCodes,
            },
            ipAddress: net.ipAddress,
            userAgent: net.userAgent,
            requestId: reqId,
            sessionId: ctx.actor.sessionId,
          },
          async (tx) => {
            const updated = await tx.securityEvent.update({
              where: { id },
              data: {
                acknowledgedAt: new Date(),
                acknowledgedById: ctx.actor.userId,
                acknowledgementNote: body.note,
              },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'SECURITY_EVENT',
                entityType: 'SECURITY_EVENT',
                entityId: id,
                entityLabel: event.type,
                description: `Security event acknowledged: ${event.type} (${event.severity})`,
                metadata: { note: body.note },
              },
              { organizationId: ctx.actor.organizationId!, ipAddress: net.ipAddress, userAgent: net.userAgent, requestId: reqId, sessionId: ctx.actor.sessionId }
            );

            return { status: 200, body: { data: updated } };
          },
        ),
    });

    if (outcome.kind === 'REPLAYED') {
      return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    }

    return ok(outcome.result, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}