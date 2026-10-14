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

/**
 * Reconciliation sessions â€” list and create (M8 Task 3, PDF Â§12).
 */

const targetSchema = z.enum([
  'BANK_STATEMENT',
  'LEDGER',
  'MOBILE_MONEY',
  'PAYMENT_GATEWAY',
  'CASH',
]);

const createSchema = z.object({
  code: z.string().min(2).max(50),
  treasuryAccountId: z.string().cuid(),
  target: targetSchema,
  importId: z.string().cuid().optional(),
  periodId: z.string().cuid().optional(),
  statementStartDate: z.string().min(1),
  statementEndDate: z.string().min(1),
  statementOpeningBalance: z.number().optional(),
  statementClosingBalance: z.number().optional(),
  autoMatchThreshold: z.number().int().min(0).max(100).optional(),
  notes: z.string().max(2000).optional(),
});

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

export async function GET(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'RECONCILIATION', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const treasuryAccountId = searchParams.get('treasuryAccountId');
    const target = searchParams.get('target');
    const outstandingOnly = searchParams.get('outstandingOnly') === 'true';

    const where: Record<string, unknown> = { organizationId: ctx.actor.organizationId };
    if (status) where.status = status;
    if (treasuryAccountId) where.treasuryAccountId = treasuryAccountId;
    if (target) where.target = target;
    // "Outstanding" is the workbench's default view: anything not yet signed off.
    if (outstandingOnly) {
      where.status = {
        in: ['NOT_STARTED', 'IN_PROGRESS', 'MATCHED', 'AWAITING_APPROVAL', 'REOPENED'],
      };
    }

    const sessions = await prisma.reconciliationSession.findMany({
      where,
      orderBy: [{ statementEndDate: 'desc' }, { code: 'asc' }],
      select: {
        id: true,
        code: true,
        target: true,
        status: true,
        currency: true,
        statementStartDate: true,
        statementEndDate: true,
        statementClosingBalance: true,
        calculatedEndingBalance: true,
        difference: true,
        autoMatchThreshold: true,
        createdAt: true,
        approvedAt: true,
        reopenedAt: true,
        treasuryAccount: { select: { id: true, code: true, name: true, kind: true } },
        _count: { select: { matches: true, exceptions: true, adjustments: true } },
      },
    });

    return ok(
      {
        data: sessions.map((s) => ({
          id: s.id,
          code: s.code,
          target: s.target,
          status: s.status,
          currency: s.currency,
          statementStartDate: s.statementStartDate,
          statementEndDate: s.statementEndDate,
          statementClosingBalance: s.statementClosingBalance,
          calculatedEndingBalance: s.calculatedEndingBalance,
          difference: s.difference,
          autoMatchThreshold: s.autoMatchThreshold,
          createdAt: s.createdAt,
          approvedAt: s.approvedAt,
          reopenedAt: s.reopenedAt,
          treasuryAccount: s.treasuryAccount,
          matchCount: s._count.matches,
          exceptionCount: s._count.exceptions,
          adjustmentCount: s._count.adjustments,
        })),
      },
      200,
      reqId,
    );
  } catch (error) {
    return apiError(error, reqId);
  }
}
export async function POST(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'RECONCILIATION', action: 'CREATE' });

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

    const body = createSchema.parse(await request.json());

    const account = await prisma.treasuryAccount.findFirst({
      where: { id: body.treasuryAccountId, organizationId: ctx.actor.organizationId },
      select: { id: true, currencyCode: true },
    });

    if (!account) {
      return apiError(new ValidationError('Treasury account not found'), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: 'POST /api/v1/reconciliations',
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
            const created = await tx.reconciliationSession.create({
              data: {
                organizationId: ctx.actor.organizationId!,
                code: body.code,
                treasuryAccountId: body.treasuryAccountId,
                target: body.target,
                importId: body.importId ?? null,
                periodId: body.periodId ?? null,
                // Currency comes from the treasury account, never the payload:
                // a client must not be able to reconcile one currency's
                // statement against another currency's balances.
                currency: account.currencyCode,
                statementStartDate: new Date(body.statementStartDate),
                statementEndDate: new Date(body.statementEndDate),
                statementOpeningBalance: body.statementOpeningBalance ?? null,
                statementClosingBalance: body.statementClosingBalance ?? null,
                autoMatchThreshold: body.autoMatchThreshold ?? 85,
                status: 'NOT_STARTED',
                notes: body.notes ?? null,
              },
              select: {
                id: true,
                code: true,
                target: true,
                status: true,
                currency: true,
                statementStartDate: true,
                statementEndDate: true,
              },
            });

            await writeAuditEntry(
              tx,
              {
                id: ctx.actor.userId,
                name: ctx.actor.fullName,
                roleCodes: ctx.actor.roleCodes,
              },
              {
                action: 'RECONCILIATION_SESSION_CREATED',
                entityType: 'RECONCILIATION_SESSION',
                entityId: created.id,
                entityLabel: created.code,
                description: `Created reconciliation session ${created.code} (${created.target})`,
                changes: {
                  code: { from: null, to: created.code },
                  target: { from: null, to: created.target },
                  status: { from: null, to: created.status },
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

            return { status: 201, body: { data: created } };
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



