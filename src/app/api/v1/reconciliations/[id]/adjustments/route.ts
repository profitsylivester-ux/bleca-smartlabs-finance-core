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
import { ValidationError } from '@/lib/kernel/errors';
import { createAdjustment } from '@/lib/reconciliation/service';

/**
 * Reconciliation adjustments (M8 Task 4, PDF §12).
 *
 * An adjustment is how a reconciliation difference is made to disappear from the
 * books, which makes it the most abusable object in this module. Two rules hold
 * it in: `reasonCodeId` is mandatory at the schema level (not merely validated
 * here), and the journal entry is created balanced and linked to the adjustment
 * in the same transaction, so an adjustment can never exist without its ledger
 * effect.
 */
const createSchema = z.object({
  accountId: z.string().cuid(),
  description: z.string().min(3).max(500),
  debit: z.number().nonnegative().optional(),
  credit: z.number().nonnegative().optional(),
  reasonCodeId: z.string().cuid(),
  documentId: z.string().cuid().optional(),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'RECONCILIATION', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const { id } = await params;

    const adjustments = await prisma.reconciliationAdjustment.findMany({
      where: { sessionId: id, organizationId: ctx.actor.organizationId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        description: true,
        debit: true,
        credit: true,
        currency: true,
        status: true,
        journalEntryId: true,
        postedAt: true,
        createdAt: true,
        account: { select: { id: true, code: true, name: true } },
        reasonCode: { select: { id: true, code: true, name: true } },
      },
    });

    return ok({ data: adjustments }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'RECONCILIATION', action: 'POST' });

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
    const body = createSchema.parse(await request.json());

    const h = await headers();
    const net = {
      ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
      userAgent: h.get('user-agent'),
      requestId: reqId,
    };

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/reconciliations/${id}/adjustments`,
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
            const created = await createAdjustment(tx, {
              sessionId: id,
              organizationId: ctx.actor.organizationId!,
              accountId: body.accountId,
              description: body.description,
              debit: body.debit ?? 0,
              credit: body.credit ?? 0,
              reasonCodeId: body.reasonCodeId,
              createdById: ctx.actor.userId,
              documentId: body.documentId,
            });

            await writeAuditEntry(
              tx,
              {
                id: ctx.actor.userId,
                name: ctx.actor.fullName,
                roleCodes: ctx.actor.roleCodes,
              },
              {
                action: 'RECONCILIATION_ADJUSTMENT_CREATED',
                entityType: 'RECONCILIATION_ADJUSTMENT',
                entityId: created.id,
                entityLabel: body.description,
                description: `Created reconciliation adjustment on session ${id}: ${body.description}`,
                metadata: {
                  sessionId: id,
                  debit: created.debit.toString(),
                  credit: created.credit.toString(),
                  reasonCodeId: body.reasonCodeId,
                  journalEntryId: created.journalEntryId,
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
              status: 201,
              body: {
                data: {
                  id: created.id,
                  status: created.status,
                  debit: created.debit.toString(),
                  credit: created.credit.toString(),
                  journalEntryId: created.journalEntryId,
                },
              },
            };
          },
        ),
    });

    if (outcome.kind === 'REPLAYED') {
      return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    }

    return ok(outcome.result, 201, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

