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
import type { Tx } from '@/lib/db/prisma';

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
    await authorize(ctx, { module: 'TREASURY_TRANSFERS', action: 'POST' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const key = request.headers.get('idempotency-key');
    if (!key) {
      return apiError(new ValidationError('An Idempotency-Key header is required on this endpoint.'), reqId);
    }

    const { id } = await params;

    const transfer = await getTransferWithRelations(id, ctx.actor.organizationId);
    if (!transfer) {
      return apiError(new NotFoundError('Transfer', id), reqId);
    }

    if (transfer.status !== 'APPROVED') {
      return apiError(new ValidationError(`Cannot process transfer in ${transfer.status} status`), reqId);
    }

    const isCrossCurrency = transfer.currencyCode !== transfer.destinationAccount.currencyCode;
    if (isCrossCurrency) {
      if (!transfer.destinationAmount || !transfer.destinationCurrencyCode || !transfer.fxRate) {
        return apiError(new ValidationError('Cross-currency transfer missing destinationAmount, destinationCurrencyCode, or fxRate'), reqId);
      }
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);
    const processDate = new Date();

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/transfers/${id}/process`,
      actorId: ctx.actor.userId,
      body: {},
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
            const periodId = await getOpenPeriodId(tx, ctx.actor.organizationId!, processDate);

            const sourceNormalBalance = transfer.sourceAccount.ledgerAccount.normalBalance;
            const destNormalBalance = transfer.destinationAccount.ledgerAccount.normalBalance;

            const sourceAmount = Number(transfer.amount);
            const destAmount = transfer.destinationAmount ? Number(transfer.destinationAmount) : sourceAmount;
            const sourceCurrency = transfer.currencyCode;
            const destCurrency = transfer.destinationCurrencyCode ?? transfer.currencyCode;
            const fxRate = transfer.fxRate ? Number(transfer.fxRate) : 1;
            const isCrossCurrency = sourceCurrency !== destCurrency;

            let sourceDebit = 0, sourceCredit = 0;
            let destDebit = 0, destCredit = 0;

            if (sourceNormalBalance === 'DEBIT') {
              sourceCredit = sourceAmount;
            } else {
              sourceDebit = sourceAmount;
            }

            if (destNormalBalance === 'DEBIT') {
              destDebit = destAmount;
            } else {
              destCredit = destAmount;
            }

            const journalEntry = await tx.journalEntry.create({
              data: {
                organizationId: ctx.actor.organizationId!,
                periodId,
                type: 'STANDARD',
                status: 'POSTED',
                source: 'TRANSFER',
                reference: transfer.reference ?? transfer.code,
                description: `Transfer from ${transfer.sourceAccount.name} to ${transfer.destinationAccount.name}: ${transfer.description ?? ''}`,
                postedById: ctx.actor.userId,
                postedAt: new Date(),
              },
            });

            await tx.journalLine.createMany({
              data: [
                {
                  organizationId: ctx.actor.organizationId!,
                  entryId: journalEntry.id,
                  accountId: transfer.sourceAccount.ledgerAccountId,
                  lineNumber: 1,
                  description: `Transfer out: ${transfer.description ?? ''}`,
                  debit: sourceDebit,
                  credit: sourceCredit,
                  currencyCode: sourceCurrency,
                  baseAmount: sourceDebit > 0 ? sourceDebit : sourceCredit,
                  fxRate: sourceCurrency === 'TZS' ? 1 : null,
                },
                {
                  organizationId: ctx.actor.organizationId!,
                  entryId: journalEntry.id,
                  accountId: transfer.destinationAccount.ledgerAccountId,
                  lineNumber: 2,
                  description: `Transfer in: ${transfer.description ?? ''}`,
                  debit: destDebit,
                  credit: destCredit,
                  currencyCode: destCurrency,
                  baseAmount: destDebit > 0 ? destDebit : destCredit,
                  fxRate: destCurrency === 'TZS' ? 1 : fxRate,
                },
              ],
            });

            if (isCrossCurrency) {
              const fxDiffAmount = destAmount - (sourceAmount * fxRate);
              if (fxDiffAmount !== 0) {
                const fxAccount = await tx.account.findFirst({
                  where: { organizationId: ctx.actor.organizationId!, type: 'EXPENSE', subCategory: 'EXPENSE_OTHER', isPostable: true, status: 'ACTIVE' },
                  select: { id: true, normalBalance: true },
                });
                if (fxAccount) {
                  await tx.journalLine.create({
                    data: {
                      organizationId: ctx.actor.organizationId!,
                      entryId: journalEntry.id,
                      accountId: fxAccount.id,
                      lineNumber: 3,
                      description: `FX difference on transfer ${transfer.code}`,
                      debit: fxDiffAmount > 0 ? Math.abs(fxDiffAmount) : 0,
                      credit: fxDiffAmount < 0 ? Math.abs(fxDiffAmount) : 0,
                      currencyCode: 'TZS',
                      baseAmount: Math.abs(fxDiffAmount),
                      fxRate: 1,
                    },
                  });
                }
              }
            }

            const updated = await tx.transfer.update({
              where: { id },
              data: {
                status: 'PROCESSED',
                processedById: ctx.actor.userId,
                processedAt: new Date(),
                journalEntryId: journalEntry.id,
              },
              select: { id: true, code: true, status: true, journalEntryId: true },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'JOURNAL_ENTRY_CREATED',
                entityType: 'TRANSFER',
                entityId: updated.id,
                entityLabel: updated.code,
                description: `Processed transfer ${updated.code}: created journal entry ${journalEntry.id}`,
                changes: { status: { from: 'APPROVED', to: 'PROCESSED' }, journalEntryId: { from: null, to: journalEntry.id } },
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