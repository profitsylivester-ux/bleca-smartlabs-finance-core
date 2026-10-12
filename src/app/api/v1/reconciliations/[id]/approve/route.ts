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
import { approveSession } from '@/lib/reconciliation/service';

/**
 * Approves a reconciliation, locking it (M8 Task 4, PDF §12).
 *
 * The gates live in the service, not here, so that any caller — API, job, or a
 * future internal path — hits the same rules. This route's job is authentication,
 * authorisation, idempotency and the audit record of who signed off.
 */
const approveSchema = z.object({ note: z.string().max(2000).optional() }).optional();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
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
    const body = approveSchema.parse(await request.json().catch(() => undefined));

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
      scope: `POST /api/v1/reconciliations/${id}/approve`,
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
            const result = await approveSession(tx, {
              sessionId: id,
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
                action: 'RECONCILIATION_APPROVED',
                entityType: 'RECONCILIATION_SESSION',
                entityId: id,
                entityLabel: session.code,
                description: `Approved reconciliation session ${session.code}`,
                changes: { status: { from: session.status, to: 'APPROVED' } },
                metadata: {
                  difference: result.difference.toString(),
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
                  difference: result.difference.toString(),
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
