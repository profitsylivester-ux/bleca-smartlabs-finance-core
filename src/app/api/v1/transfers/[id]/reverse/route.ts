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
import type { Tx } from '@/lib/db/prisma';

const reverseSchema = z.object({
  reason: z.string().min(1),
  evidenceDocumentId: z.string().cuid().optional(),
});

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
      journalEntryId: true,
      sourceAccount: { select: { id: true, code: true, name: true, kind: true, currencyCode: true, ledgerAccountId: true, ledgerAccount: { select: { id: true, normalBalance: true } } } },
      destinationAccount: { select: { id: true, code: true, name: true, kind: true, currencyCode: true, ledgerAccountId: true, ledgerAccount: { select: { id: true, normalBalance: true } } } },
    },
  });
}

async function getOpenPeriodId(tx: Tx, organizationId: string, date: Date) {
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
    await authorize(ctx, { module: 'TREASURY_TRANSFERS', action: 'REVERSE' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const key = request.headers.get('idempotency-key');
    if (!key) {
      return apiError(new ValidationError('An Idempotency-Key header is required on this endpoint.'), reqId);
    }

    const { id } = await params;
    const body = reverseSchema.parse(await request.json());

    const transfer = await getTransferWithRelations(id, ctx.actor.organizationId);
    if (!transfer) {
      return apiError(new NotFoundError('Transfer', id), reqId);
    }

    if (transfer.status !== 'PROCESSED') {
      return apiError(new ValidationError(`Cannot reverse transfer in ${transfer.status} status`), reqId);
    }

    if (!transfer.journalEntryId) {
      return apiError(new ValidationError('Transfer has no journal entry to reverse'), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);
    const reverseDate = new Date();

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/transfers/${id}/reverse`,
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
            const originalEntry = await tx.journalEntry.findUnique({
              where: { id: transfer.journalEntryId! },
              include: { lines: true },
            });
            if (!originalEntry) {
              throw new ValidationError('Original journal entry not found');
            }

            const periodId = await getOpenPeriodId(tx, ctx.actor.organizationId!, reverseDate);

            const sourceNormalBalance = transfer.sourceAccount.ledgerAccount.normalBalance;
            const destNormalBalance = transfer.destinationAccount.ledgerAccount.normalBalance;

            const sourceAmount = Number(transfer.amount);
            const destAmount = transfer.destinationAmount ? Number(transfer.destinationAmount) : sourceAmount;
            const sourceCurrency = transfer.currencyCode;
            const destCurrency = transfer.destinationCurrencyCode ?? transfer.currencyCode;

            let sourceDebit = 0, sourceCredit = 0;
            let destDebit = 0, destCredit = 0;

            if (sourceNormalBalance === 'DEBIT') {
              sourceDebit = sourceAmount;
            } else {
              sourceCredit = sourceAmount;
            }

            if (destNormalBalance === 'DEBIT') {
              destCredit = destAmount;
            } else {
              destDebit = destAmount;
            }

            const reversalEntry = await tx.journalEntry.create({
              data: {
                organizationId: ctx.actor.organizationId!,
                periodId,
                type: 'REVERSAL',
                status: 'POSTED',
                source: 'REVERSAL',
                reference: `REV-${transfer.reference ?? transfer.code}`,
                description: `Reversal of transfer ${transfer.code}: ${body.reason}`,
                reversedEntryId: originalEntry.id,
                reversalReasonId: null,
                postedById: ctx.actor.userId,
                postedAt: new Date(),
              },
            });

            await tx.journalLine.createMany({
              data: [
                {
                  organizationId: ctx.actor.organizationId!,
                  entryId: reversalEntry.id,
                  accountId: transfer.sourceAccount.ledgerAccountId,
                  lineNumber: 1,
                  description: `Reversal of transfer out: ${transfer.description ?? ''}`,
                  debit: sourceDebit,
                  credit: sourceCredit,
                  currencyCode: sourceCurrency,
                  baseAmount: sourceDebit > 0 ? sourceDebit : sourceCredit,
                  fxRate: sourceCurrency === 'TZS' ? 1 : null,
                },
                {
                  organizationId: ctx.actor.organizationId!,
                  entryId: reversalEntry.id,
                  accountId: transfer.destinationAccount.ledgerAccountId,
                  lineNumber: 2,
                  description: `Reversal of transfer in: ${transfer.description ?? ''}`,
                  debit: destDebit,
                  credit: destCredit,
                  currencyCode: destCurrency,
                  baseAmount: destDebit > 0 ? destDebit : destCredit,
                  fxRate: destCurrency === 'TZS' ? 1 : transfer.fxRate ?? 1,
                },
              ],
            });

            const updated = await tx.transfer.update({
              where: { id },
              data: {
                status: 'REVERSED',
                reversedById: ctx.actor.userId,
                reversedAt: new Date(),
                reversalJournalEntryId: reversalEntry.id,
              },
              select: { id: true, code: true, status: true, reversalJournalEntryId: true },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'JOURNAL_ENTRY_REVERSED',
                entityType: 'TRANSFER',
                entityId: updated.id,
                entityLabel: updated.code,
                description: `Reversed transfer ${updated.code}: created reversal journal entry ${reversalEntry.id}`,
                changes: { status: { from: 'PROCESSED', to: 'REVERSED' }, reversalJournalEntryId: { from: null, to: reversalEntry.id } },
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