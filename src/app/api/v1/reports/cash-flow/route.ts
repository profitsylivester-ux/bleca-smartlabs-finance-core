import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { prisma, AccountSubCategory } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';

const querySchema = z.object({
  periodId: z.string().cuid().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  currency: z.string().length(3).optional(),
});

const CASH_ACCOUNTS = [AccountSubCategory.CASH, AccountSubCategory.BANK, AccountSubCategory.MOBILE_MONEY];

async function getCashFlowData(
  organizationId: string,
  params: { startDate?: Date; endDate?: Date; periodId?: string; currency?: string }
) {
  const entryWhere: Prisma.JournalEntryWhereInput = {
    organizationId,
    status: { in: ['POSTED', 'LOCKED'] },
  };
  if (params.periodId) entryWhere.periodId = params.periodId;
  if (params.startDate || params.endDate) {
    entryWhere.postedAt = {};
    if (params.startDate) entryWhere.postedAt.gte = params.startDate;
    if (params.endDate) entryWhere.postedAt.lte = params.endDate;
  }

  const where: Prisma.JournalLineWhereInput = {
    organizationId,
    account: { subCategory: { in: CASH_ACCOUNTS } },
    entry: entryWhere,
  };
  if (params.currency) where.currencyCode = params.currency;

  const cashLines = await prisma.journalLine.findMany({
    where,
    include: {
      account: { select: { id: true, code: true, name: true, subCategory: true, type: true, normalBalance: true } },
      entry: { select: { id: true, source: true, postedAt: true, description: true } },
    },
  });

  const cashAccounts = await prisma.account.findMany({
    where: { organizationId, subCategory: { in: CASH_ACCOUNTS } },
    select: { id: true, code: true, name: true, subCategory: true, normalBalance: true },
  });

  const openingBalances = await prisma.accountBalanceSnapshot.findMany({
    where: {
      accountId: { in: cashAccounts.map(a => a.id) },
      organizationId,
      ...(params.currency ? { currencyCode: params.currency } : {}),
    },
  });

  const openingCash = openingBalances.reduce((sum, b) => sum + Number(b.balance), 0);

  let operating = 0;
  let investing = 0;
  let financing = 0;

  for (const line of cashLines) {
    const amount = Number(line.debit) - Number(line.credit);
    const entrySource = line.entry.source;

    if (entrySource === 'MANUAL' || entrySource === 'TRANSACTION' || entrySource === 'INVOICE' || entrySource === 'PAYMENT' || entrySource === 'RECEIPT') {
      const account = line.account;
      if (account.type === 'REVENUE' || account.type === 'EXPENSE') {
        operating += amount;
      } else if (account.type === 'ASSET' && account.subCategory !== 'CASH' && account.subCategory !== 'BANK' && account.subCategory !== 'MOBILE_MONEY') {
        investing += amount;
      } else if (account.type === 'LIABILITY' || account.type === 'EQUITY') {
        financing += amount;
      }
    }
  }

  const closingCash = openingCash + operating + investing + financing;

  return {
    openingCash,
    operating,
    investing,
    financing,
    closingCash,
    netChange: operating + investing + financing,
  };
}

export async function GET(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'REPORTS', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new Error('No organization context'), reqId);
    }

    const url = new URL(request.url);
    const query = querySchema.parse(Object.fromEntries(url.searchParams));

    let startDate: Date | undefined;
    let endDate: Date | undefined;
    const periodId = query.periodId;

    if (query.periodId) {
      const period = await prisma.financialPeriod.findFirst({
        where: { id: query.periodId, organizationId: ctx.actor.organizationId },
        select: { startDate: true, endDate: true },
      });
      if (period) {
        startDate = period.startDate;
        endDate = period.endDate;
      }
    } else {
      if (query.startDate) startDate = new Date(query.startDate);
      if (query.endDate) endDate = new Date(query.endDate);
    }

    const data = await getCashFlowData(ctx.actor.organizationId, {
      startDate,
      endDate,
      periodId,
      currency: query.currency,
    });

    return ok({
      data: {
        operatingActivities: { netCashFromOperating: data.operating },
        investingActivities: { netCashFromInvesting: data.investing },
        financingActivities: { netCashFromFinancing: data.financing },
        netChangeInCash: data.netChange,
        cashAtBeginning: data.openingCash,
        cashAtEnd: data.closingCash,
        period: { periodId: query.periodId, startDate, endDate },
      },
    }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}