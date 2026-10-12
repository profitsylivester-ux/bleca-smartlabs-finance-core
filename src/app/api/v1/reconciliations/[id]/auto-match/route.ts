import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';
import { autoMatch } from '@/lib/reconciliation/service';

/**
 * Runs the matching engine over a session.
 *
 * The contract this route exists to hold: every row it creates is PROPOSED.
 * Nothing is confirmed here, by any threshold, for any caller. Confirmation is
 * POST /api/v1/matches/[id]/confirm and requires a human. A caller who expects
 * this endpoint to produce a reconciled session is misreading it, and the audit
 * action name says so explicitly.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'RECONCILIATION', action: 'EDIT' });

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

    const session = await prisma.reconciliationSession.findFirst({
      where: { id, organizationId: ctx.actor.organizationId },
      select: { id: true, code: true, status: true },
    });

    if (!session) {
      return apiError(new NotFoundError('Reconciliation session', id), reqId);
    }

    if (session.status === 'LOCKED') {
      return apiError(
        new ValidationError(`Session ${session.code} is locked and cannot be re-matched.`),
        reqId,
      );
    }

    const h = await headers();
    const net = {
      ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
      userAgent: h.get('user-agent'),
      requestId: reqId,
    };

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/reconciliations/${id}/auto-match`,
      actorId: ctx.actor.userId,
      body: { sessionId: id },
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
            const result = await autoMatch(tx, {
              sessionId: id,
              organizationId: ctx.actor.organizationId!,
              actorId: ctx.actor.userId,
            });

            await writeAuditEntry(
              tx,
              {
                id: ctx.actor.userId,
                name: ctx.actor.fullName,
                roleCodes: ctx.actor.roleCodes,
              },
              {
                action: 'RECONCILIATION_AUTO_MATCHED',
                entityType: 'RECONCILIATION_SESSION',
                entityId: id,
                entityLabel: session.code,
                description:
                  `Auto-matched session ${session.code}: ${result.proposed} proposed ` +
                  `(awaiting human confirmation), ${result.exceptions} exceptions`,
                metadata: {
                  proposed: result.proposed,
                  exceptions: result.exceptions,
                  belowThreshold: result.belowThreshold,
                  byRule: result.byRule,
                  // Recorded so the audit trail can never be read as implying
                  // the engine confirmed anything.
                  autoConfirmed: false,
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

            return {
              status: 200,
              body: {
                data: {
                  sessionId: id,
                  proposed: result.proposed,
                  exceptions: result.exceptions,
                  belowThreshold: result.belowThreshold,
                  byRule: result.byRule,
                  // Explicit in the response, not just the docs: these rows are
                  // proposals and nothing has been confirmed.
                  autoConfirmed: false,
                  requiresConfirmation: result.proposed,
                },
              },
            };
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
