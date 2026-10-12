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
import { confirmMatch } from '@/lib/reconciliation/service';

/**
 * Human confirmation of a proposed match (M8 Task 3, PDF §12).
 *
 * This is the only endpoint in the system that may move a match to MATCHED, and
 * it is gated on an authenticated actor with APPROVE on RECONCILIATION. There
 * is deliberately no bulk or "confirm all" variant: the point of the control is
 * that each pairing is an individual human assertion, recorded with the id of
 * the human who made it.
 */
const confirmSchema = z
  .object({
    note: z.string().max(1000).optional(),
  })
  .optional();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    // APPROVE, not EDIT: confirming a match is an assertion about the books.
    await authorize(ctx, { module: 'RECONCILIATION', action: 'APPROVE' });

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
    const body = confirmSchema.parse(await request.json().catch(() => undefined));

    const existing = await prisma.reconciliationMatch.findFirst({
      where: { id, organizationId: ctx.actor.organizationId },
      select: { id: true, status: true, sessionId: true },
    });

    if (!existing) {
      return apiError(new NotFoundError('Reconciliation match', id), reqId);
    }

    const h = await headers();
    const net = {
      ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
      userAgent: h.get('user-agent'),
      requestId: reqId,
    };

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/matches/${id}/confirm`,
      actorId: ctx.actor.userId,
      body: body ?? {},
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
            const result = await confirmMatch(tx, {
              matchId: id,
              organizationId: ctx.actor.organizationId!,
              actor: {
                id: ctx.actor.userId,
                name: ctx.actor.fullName,
                roleCodes: ctx.actor.roleCodes,
              },
              note: body?.note,
            });

            await writeAuditEntry(
              tx,
              {
                id: ctx.actor.userId,
                name: ctx.actor.fullName,
                roleCodes: ctx.actor.roleCodes,
              },
              {
                action: 'RECONCILIATION_MATCH_CONFIRMED',
                entityType: 'RECONCILIATION_MATCH',
                entityId: result.id,
                entityLabel: existing.sessionId,
                description: `Confirmed reconciliation match ${result.id}`,
                changes: {
                  status: { from: existing.status, to: 'MATCHED' },
                },
                metadata: {
                  sessionId: existing.sessionId,
                  note: body?.note ?? null,
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
                  id: result.id,
                  status: result.status,
                  sessionId: existing.sessionId,
                  difference: result.differenceAmount.toString(),
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
