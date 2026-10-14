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

const submitSchema = z.object({
  reason: z.string().optional(),
  evidenceDocumentId: z.string().optional(),
}).optional();

import { z } from 'zod';

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

async function getTransferWithRelations(id: string, orgId: string) {
  return prisma.transfer.findFirst({
    where: { id, organizationId: orgId },
    select: {
      id: true,
      code: true,
      status: true,
      sourceAccountId: true,
      destinationAccountId: true,
      amount: true,
      currencyCode: true,
      destinationAmount: true,
      destinationCurrencyCode: true,
      fxRate: true,
      description: true,
      reference: true,
      sourceAccount: { select: { id: true, code: true, name: true, kind: true, currencyCode: true, ledgerAccountId: true, ledgerAccount: { select: { id: true, normalBalance: true } } } },
      destinationAccount: { select: { id: true, code: true, name: true, kind: true, currencyCode: true, ledgerAccountId: true, ledgerAccount: { select: { id: true, normalBalance: true } } } },
    },
  });
}

async function getOpenPeriodId(tx: typeof prisma, organizationId: string, date: Date) {
  const period = await tx.financialPeriod.findFirst({
    where: { organizationId, status: 'OPEN', startDate: { lte: date }, endDate: { gte: date } },
    orderBy: { startDate: 'asc' },
    select: { id: true },
  });
  if (!period) {
    const anyOpen = await tx.financialPeriod.findFirst({
      where: { organizationId, status: 'OPEN' },
      orderBy: { startDate: 'asc' },
      select: { id: true },
    });
    if (!anyOpen) throw new ValidationError('No open financial period found for posting', { details: { organizationId } });
    return anyOpen.id;
  }
  return period.id;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'TREASURY_TRANSFERS', action: 'SUBMIT' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const key = request.headers.get('idempotency-key');
    if (!key) {
      return apiError(new ValidationError('An Idempotency-Key header is required on this endpoint.'), reqId);
    }

    const { id } = await params;
    const body = submitSchema.parse(await request.json());

    const transfer = await getTransferWithRelations(id, ctx.actor.organizationId);
    if (!transfer) {
      return apiError(new NotFoundError('Transfer', id), reqId);
    }

    if (transfer.status !== 'DRAFT') {
      return apiError(new ValidationError(`Cannot submit transfer in ${transfer.status} status`), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/transfers/${id}/submit`,
      actorId: ctx.actor.userId,
      body,
      handler: async () =>
        withAudit(
          {
            organizationId: ctx.actor.organizationId,
            actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
            ipAddress: net.ipAddress,
            userAgent: net.userAgent,
            requestId: reqId,
            sessionId: ctx.actor.sessionId,
          },
          async (tx) => {
            const updated = await tx.transfer.update({
              where: { id },
              data: {
                status: 'SUBMITTED',
                submittedById: ctx.actor.userId,
                submittedAt: new Date(),
              },
              select: { id: true, code: true, status: true },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'JOURNAL_ENTRY_SUBMITTED',
                entityType: 'TRANSFER',
                entityId: updated.id,
                entityLabel: updated.code,
                description: `Submitted transfer ${updated.code} for approval`,
                changes: { status: { from: 'DRAFT', to: 'SUBMITTED' } },
              },
              { organizationId: ctx.actor.organizationId, ipAddress: net.ipAddress, userAgent: net.userAgent, requestId: reqId, sessionId: ctx.actor.sessionId },
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
