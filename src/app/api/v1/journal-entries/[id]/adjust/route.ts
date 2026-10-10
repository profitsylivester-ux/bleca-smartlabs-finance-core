import { NextResponse } from 'next/server';
import { z } from 'zod';
import { headers } from 'next/headers';
import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';

const adjustSchema = z.object({
  reversalReasonId: z.string().cuid(),
  lines: z.array(z.object({
    accountId: z.string().cuid(),
    lineNumber: z.int().positive(),
    description: z.string().max(500).nullish(),
    debit: z.number().min(0).default(0),
    credit: z.number().min(0).default(0),
    currencyCode: z.string().length(3),
    projectId: z.string().cuid().nullish(),
    departmentId: z.string().cuid().nullish(),
    costCentreId: z.string().cuid().nullish(),
    locationId: z.string().cuid().nullish(),
    fundingSourceId: z.string().cuid().nullish(),
  })).min(2, 'At least 2 lines required'),
});

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

async function getJournalEntryWithLines(id: string, orgId: string) {
  return prisma.journalEntry.findFirst({
    where: { id, organizationId: orgId },
    select: {
      id: true,
      periodId: true,
      status: true,
      number: true,
      reference: true,
      period: { select: { id: true, code: true, name: true, status: true } },
      lines: {
        include: { account: { select: { id: true, code: true, name: true, isPostable: true, status: true } } },
        orderBy: { lineNumber: 'asc' },
      },
    },
  });
}

function calculateBalance(lines: Array<{ debit: number | Prisma.Decimal; credit: number | Prisma.Decimal }>) {
  const totalDebit = lines.reduce((sum, l) => sum + Number(l.debit), 0);
  const totalCredit = lines.reduce((sum, l) => sum + Number(l.credit), 0);
  return { totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.000001 };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'JOURNAL_ENTRIES', action: 'CREATE' });

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
    const body = adjustSchema.parse(await request.json());

    const existing = await getJournalEntryWithLines(id, ctx.actor.organizationId);
    if (!existing) {
      return apiError(new NotFoundError('Journal entry', id), reqId);
    }

    if (existing.status !== 'POSTED' && existing.status !== 'LOCKED') {
      return apiError(
        new ValidationError(`Cannot adjust journal entry with status ${existing.status}. Only POSTED or LOCKED entries can be adjusted.`),
        reqId,
      );
    }

    const balance = calculateBalance(body.lines as Array<{ debit: number | Prisma.Decimal; credit: number | Prisma.Decimal }>);
    if (!balance.balanced) {
      return apiError(
        new ValidationError(`Adjusting entry is unbalanced: debits=${balance.totalDebit} credits=${balance.totalCredit}`),
        reqId,
      );
    }

    const accountIds = [...new Set(body.lines.map((l) => l.accountId))];
    const accounts = await prisma.account.findMany({
      where: { id: { in: accountIds }, organizationId: ctx.actor.organizationId },
      select: { id: true, code: true, isPostable: true, status: true },
    });
    if (accounts.length !== accountIds.length) {
      return apiError(new NotFoundError('One or more accounts not found'), reqId);
    }
    for (const acc of accounts) {
      if (!acc.isPostable || acc.status !== 'ACTIVE') {
        return apiError(new ValidationError(`Account ${acc.code} is not postable`), reqId);
      }
    }

    const currencies = new Set(body.lines.map((l) => l.currencyCode));
    if (currencies.size > 1) {
      return apiError(
        new ValidationError('All lines in a journal entry must share the same currency.'),
        reqId,
      );
    }

    const reason = await prisma.reversalReasonCode.findFirst({
      where: { id: body.reversalReasonId, organizationId: ctx.actor.organizationId },
      select: { id: true },
    });
    if (!reason) {
      return apiError(new NotFoundError('Reversal reason', body.reversalReasonId), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/journal-entries/${id}/adjust`,
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
            const adjustmentNumber = await getNextJournalNumber(tx, ctx.actor.organizationId!, existing.periodId ?? '');

            const adjustmentEntry = await tx.journalEntry.create({
              data: {
                organizationId: ctx.actor.organizationId!,
                periodId: existing.periodId,
                type: 'ADJUSTMENT',
                status: 'DRAFT',
                source: 'MANUAL',
                number: adjustmentNumber,
                reference: existing.reference,
                description: `Adjustment to ${existing.number ?? existing.id}`,
                adjustingEntryId: existing.id,
                reversalReasonId: body.reversalReasonId,
                lines: {
                  create: body.lines.map((line) => ({
                    organizationId: ctx.actor.organizationId!,
                    accountId: line.accountId,
                    lineNumber: line.lineNumber,
                    description: line.description ?? undefined,
                    debit: line.debit,
                    credit: line.credit,
                    currencyCode: line.currencyCode,
                    baseAmount: line.debit + line.credit,
                    projectId: line.projectId,
                    departmentId: line.departmentId,
                    costCentreId: line.costCentreId,
                    locationId: line.locationId,
                    fundingSourceId: line.fundingSourceId,
                  })),
                },
              },
              include: {
                period: { select: { id: true, code: true, name: true, status: true } },
                lines: {
                  include: {
                    account: { select: { id: true, code: true, name: true } },
                    project: { select: { id: true, code: true, name: true } },
                    department: { select: { id: true, code: true, name: true } },
                    costCentre: { select: { id: true, code: true, name: true } },
                    location: { select: { id: true, code: true, name: true } },
                    fundingSource: { select: { id: true, code: true, name: true } },
                  },
                  orderBy: { lineNumber: 'asc' },
                },
              },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'JOURNAL_ENTRY_CREATED',
                entityType: 'JOURNAL_ENTRY',
                entityId: adjustmentEntry.id,
                entityLabel: adjustmentEntry.number ?? adjustmentEntry.id,
                description: `Created adjusting entry ${adjustmentEntry.number ?? adjustmentEntry.id} for ${existing.number ?? existing.id}`,
                changes: {
                  status: { from: null, to: 'DRAFT' },
                  type: { from: null, to: 'ADJUSTMENT' },
                  number: { from: null, to: adjustmentEntry.number },
                  adjustingEntryId: { from: null, to: existing.id },
                  reversalReasonId: { from: null, to: body.reversalReasonId },
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

            return { status: 201, body: { data: adjustmentEntry } };
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

async function getNextJournalNumber(tx: Prisma.TransactionClient, organizationId: string, periodId: string): Promise<string> {
  const lastEntry = await tx.journalEntry.findFirst({
    where: { organizationId, periodId, number: { not: null } },
    orderBy: { number: 'desc' },
    select: { number: true },
  });

  let nextNum = 1;
  if (lastEntry?.number) {
    const match = lastEntry.number.match(/^JE-(\d+)$/);
    if (match && match[1]) {
      nextNum = parseInt(match[1], 10) + 1;
    }
  }

  return `JE-${String(nextNum).padStart(6, '0')}`;
}