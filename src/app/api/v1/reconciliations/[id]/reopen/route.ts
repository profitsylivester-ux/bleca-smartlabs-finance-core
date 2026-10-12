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
import { reopenSession } from '@/lib/reconciliation/service';

/**
 * Reopens an approved reconciliation (M8 Task 4, PDF §12).
 *
 * `reason` is required at the schema level, not merely in the handler: reopening
 * unwinds a signed-off assertion, and an unexplained reopen would leave no way
 * to distinguish a legitimate correction from an attempt to quietly alter a
 * closed period.
 */
const reopenSchema = z.object({
  reason: z.string().min(10, 'A reason of at least 10 characters is required to reopen.'),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'RECONCILIATION', action: 'REVERSE' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const key = request.headers.get('idempotency-key');
    if (!key) {
      return apiError(
        new ValidationError('An Idempotency-Key header is required on this endpoint.'),
        reqId,
      );
    }

    const { id } = await params;
    const body = reopenSchema.parse(await request.json());

    const session = await prisma.reconciliationSession.findFirst({
      where: { id, organizationId: ctx.actor.organizationId },
      select: { id: true, code: true, status: true },
    });

    if (!session) {
      return apiError(new NotFoundError('Reconciliation session', id), reqId);
    }

    const h = await headers();
    const net = {
      ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
      userAgent: h.get('user-agent'),
      requestId: reqId,
    };

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/reconciliations/${id}/reopen`,
      actorId: ctx.actor.userId,
      body,
      handler: async () =>
        withAudit(
          {
            organizationId: ctx.actor.organizationId,
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
            const result = await reopenSession(tx, {
              sessionId: id,
              organizationId: ctx.actor.organizationId!,
              reason: body.reason,
            });

            await writeAuditEntry(
              tx,
              {
                id: ctx.actor.userId,
                name: ctx.actor.fullName,
                roleCodes: ctx.actor.roleCodes,
              },
              {
                action: 'RECONCILIATION_REOPENED',
                entityType: 'RECONCILIATION_SESSION',
                entityId: id,
                entityLabel: session.code,
                description: `Reopened reconciliation session ${session.code}: ${body.reason}`,
                changes: { status: { from: session.status, to: 'REOPENED' } },
                metadata: {
                  reason: body.reason,
                  reopenCount: result.reopenCount,
                },
              },
              {
                organizationId: ctx.actor.organizationId,
                ipAddress: net.ipAddress,
                userAgent: net.userAgent,
                requestId: reqId,
                sessionId: ctx.actor.sessionId,
              },
            );

            return { status: 200, body: { data: result } };
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
