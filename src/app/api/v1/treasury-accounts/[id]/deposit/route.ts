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
import { ValidationError, NotFoundError } from '@/lib/kernel/errors';
import type { Tx } from '@/lib/db/prisma';

const depositSchema = z.object({
  amount: z.number().positive(),
  currencyCode: z.string().length(3),
  date: z.string().min(1).optional(),
  description: z.string().optional(),
  reference: z.string().optional(),
  projectId: z.string().cuid().optional(),
  departmentId: z.string().cuid().optional(),
  costCentreId: z.string().cuid().optional(),
  fundingSourceId: z.string().cuid().optional(),
  supportingDocumentId: z.string().cuid().optional(),
});

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

async function getTreasuryAccount(id: string, orgId: string) {
  return prisma.treasuryAccount.findFirst({
    where: { id, organizationId: orgId },
    select: {
      id: true,
      code: true,
      name: true,
      kind: true,
      currencyCode: true,
      ledgerAccountId: true,
      isActive: true,
      isRestricted: true,
      ledgerAccount: {
        select: { id: true, normalBalance: true, type: true, code: true, name: true },
      },
    },
  });
}

async function findCounterpartyAccount(
  tx: Tx,
  organizationId: string,
  treasuryAccount: { ledgerAccount: { type: string; normalBalance: string } },
  isDeposit: boolean
) {
  if (isDeposit) {
    const counterparty = await tx.account.findFirst({
      where: {
        organizationId,
        type: { in: ['REVENUE', 'LIABILITY'] },
        isPostable: true,
        status: 'ACTIVE',
      },
      orderBy: { code: 'asc' },
      select: { id: true, normalBalance: true, type: true, code: true, name: true },
    });
    return counterparty;
  } else {
    const counterparty = await tx.account.findFirst({
      where: {
        organizationId,
        type: { in: ['EXPENSE', 'ASSET'] },
        isPostable: true,
        status: 'ACTIVE',
      },
      orderBy: { code: 'asc' },
      select: { id: true, normalBalance: true, type: true, code: true, name: true },
    });
    return counterparty;
  }
}

async function getOpenPeriodId(tx: Tx, organizationId: string, date: Date) {
  const period = await tx.financialPeriod.findFirst({
    where: {
      organizationId,
      status: 'OPEN',
      startDate: { lte: date },
      endDate: { gte: date },
    },
    orderBy: { startDate: 'asc' },
    select: { id: true },
  });

  if (!period) {
    const anyOpen = await tx.financialPeriod.findFirst({
      where: { organizationId, status: 'OPEN' },
      orderBy: { startDate: 'asc' },
      select: { id: true },
    });
    if (!anyOpen) {
      throw new ValidationError('No open financial period found for posting', { details: { organizationId } });
    }
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
    await authorize(ctx, { module: 'TREASURY_TRANSFERS', action: 'CREATE' });

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
    const body = depositSchema.parse(await request.json());

    const treasuryAccount = await getTreasuryAccount(id, ctx.actor.organizationId);
    if (!treasuryAccount) {
      return apiError(new NotFoundError('Treasury account', id), reqId);
    }

    if (!treasuryAccount.isActive) {
      return apiError(new ValidationError('Treasury account is not active'), reqId);
    }

    if (body.currencyCode !== treasuryAccount.currencyCode) {
      return apiError(
        new ValidationError(`Currency mismatch: treasury account uses ${treasuryAccount.currencyCode}, request uses ${body.currencyCode}`),
        reqId,
      );
    }

    if (treasuryAccount.isRestricted && treasuryAccount.kind === 'GRANT_FUND') {
      if (body.fundingSourceId) {
        const fs = await prisma.fundingSource.findUnique({
          where: { id: body.fundingSourceId },
          select: { isRestricted: true, type: true },
        });
        if (!fs || !fs.isRestricted) {
          return apiError(
            new ValidationError('Restricted grant account requires a restricted funding source'),
            reqId,
          );
        }
      }
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);
    const transactionDate = body.date ? new Date(body.date) : new Date();
    const reference = body.reference ?? `DEP-${treasuryAccount.code}-${Date.now()}`;

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/treasury-accounts/${id}/deposit`,
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
            const transaction = await tx.transaction.create({
              data: {
                organizationId: ctx.actor.organizationId!,
                status: 'POSTED',
                date: transactionDate,
                description: body.description ?? `Deposit to ${treasuryAccount.name}`,
                reference,
                accountId: treasuryAccount.ledgerAccountId,
                amount: body.amount,
                currencyCode: body.currencyCode,
                paymentMethod: treasuryAccount.kind === 'CASH' ? 'CASH' : 
                  treasuryAccount.kind === 'BANK' ? 'BANK_TRANSFER' :
                  treasuryAccount.kind === 'MOBILE_MONEY' ? 'MOBILE_MONEY' :
                  treasuryAccount.kind === 'PAYMENT_GATEWAY' ? 'PAYMENT_GATEWAY' : 'OTHER',
                projectId: body.projectId,
                departmentId: body.departmentId,
                costCentreId: body.costCentreId,
                fundingSourceId: body.fundingSourceId,
                supportingDocumentId: body.supportingDocumentId,
                treasuryAccountId: treasuryAccount.id,
                postedById: ctx.actor.userId,
                postedAt: new Date(),
                createdById: ctx.actor.userId,
              },
              select: { id: true, reference: true },
            });

            const counterparty = await findCounterpartyAccount(tx, ctx.actor.organizationId!, treasuryAccount, true);
            if (!counterparty) {
              throw new ValidationError('No suitable counterparty account found for deposit');
            }

            const periodId = await getOpenPeriodId(tx, ctx.actor.organizationId!, transactionDate);

            const journalEntry = await tx.journalEntry.create({
              data: {
                organizationId: ctx.actor.organizationId!,
                periodId,
                type: 'STANDARD',
                status: 'POSTED',
                source: 'TRANSACTION',
                reference: transaction.reference,
                description: `Deposit to ${treasuryAccount.name}: ${body.description ?? ''}`,
                transactionId: transaction.id,
                postedById: ctx.actor.userId,
                postedAt: new Date(),
              },
            });

            const treasuryNormalBalance = treasuryAccount.ledgerAccount.normalBalance;
            const amount = body.amount;
            let treasuryDebit = 0, treasuryCredit = 0;
            let counterpartyDebit = 0, counterpartyCredit = 0;

            if (treasuryNormalBalance === 'DEBIT') {
              treasuryDebit = amount;
              counterpartyCredit = amount;
            } else {
              treasuryCredit = amount;
              counterpartyDebit = amount;
            }

            await tx.journalLine.createMany({
              data: [
                {
                  organizationId: ctx.actor.organizationId!,
                  entryId: journalEntry.id,
                  accountId: treasuryAccount.ledgerAccountId,
                  lineNumber: 1,
                  description: `Deposit to ${treasuryAccount.name}: ${body.description ?? ''}`,
                  debit: treasuryDebit,
                  credit: treasuryCredit,
                  currencyCode: body.currencyCode,
                  baseAmount: amount,
                  fxRate: body.currencyCode === 'TZS' ? 1 : null,
                  projectId: body.projectId,
                  departmentId: body.departmentId,
                  costCentreId: body.costCentreId,
                  fundingSourceId: body.fundingSourceId,
                },
                {
                  organizationId: ctx.actor.organizationId!,
                  entryId: journalEntry.id,
                  accountId: counterparty.id,
                  lineNumber: 2,
                  description: `Counterparty for deposit to ${treasuryAccount.name}`,
                  debit: counterpartyDebit,
                  credit: counterpartyCredit,
                  currencyCode: body.currencyCode,
                  baseAmount: amount,
                  fxRate: body.currencyCode === 'TZS' ? 1 : null,
                  projectId: body.projectId,
                  departmentId: body.departmentId,
                  costCentreId: body.costCentreId,
                  fundingSourceId: body.fundingSourceId,
                },
              ],
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'JOURNAL_ENTRY_CREATED',
                entityType: 'JOURNAL_ENTRY',
                entityId: journalEntry.id,
                entityLabel: transaction.reference ?? transaction.id,
                description: `Created deposit transaction ${transaction.id} for treasury account ${treasuryAccount.code}`,
                changes: {
                  amount: { from: null, to: body.amount },
                  currencyCode: { from: null, to: body.currencyCode },
                  treasuryAccountId: { from: null, to: treasuryAccount.id },
                  treasuryAccountCode: { from: null, to: treasuryAccount.code },
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

            return { status: 201, body: { data: { transactionId: transaction.id, journalEntryId: journalEntry.id } } };
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
