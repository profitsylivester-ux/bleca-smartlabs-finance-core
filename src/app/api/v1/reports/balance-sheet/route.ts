import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';

const querySchema = z.object({
  asAtDate: z.string().datetime().optional(),
  currency: z.string().length(3).optional(),
  comparativeDate: z.string().datetime().optional(),
});

const ASSET_CATEGORIES = [
  'CASH', 'BANK', 'MOBILE_MONEY', 'RECEIVABLE', 'INVENTORY', 'EQUIPMENT', 'OTHER_ASSET',
];

const LIABILITY_CATEGORIES = [
  'SUPPLIER_PAYABLE', 'TAX_PAYABLE', 'LOAN', 'ACCRUED_EXPENSE', 'OTHER_OBLIGATION',
];

const EQUITY_CATEGORIES = [
  'CAPITAL', 'RETAINED_EARNINGS', 'FUTURE_INVESTMENT',
];

async function getBalances(
  organizationId: string,
  asAtDate: Date,
  currency?: string
) {
  const entryWhere: Prisma.JournalEntryWhereInput = {
    organizationId,
    status: { in: ['POSTED', 'LOCKED'] },
    postedAt: { lte: asAtDate },
  };

  const where: Prisma.JournalLineWhereInput = {
    organizationId,
    account: { type: { in: ['ASSET', 'LIABILITY', 'EQUITY'] } },
    entry: entryWhere,
  };
  if (currency) where.currencyCode = currency;

  const lines = await prisma.journalLine.findMany({
    where,
    include: { account: { select: { id: true, code: true, name: true, subCategory: true, type: true, normalBalance: true } } },
  });

  const assetByCategory: Record<string, number> = {};
  const liabilityByCategory: Record<string, number> = {};
  const equityByCategory: Record<string, number> = {};

  for (const line of lines) {
    const debit = Number(line.debit);
    const credit = Number(line.credit);
    const balance = line.account.normalBalance === 'DEBIT' ? debit - credit : credit - debit;
    const cat = line.account.subCategory || 'UNCATEGORIZED';

    if (line.account.type === 'ASSET') {
      assetByCategory[cat] = (assetByCategory[cat] || 0) + balance;
    } else if (line.account.type === 'LIABILITY') {
      liabilityByCategory[cat] = (liabilityByCategory[cat] || 0) + balance;
    } else if (line.account.type === 'EQUITY') {
      equityByCategory[cat] = (equityByCategory[cat] || 0) + balance;
    }
  }

  return { assetByCategory, liabilityByCategory, equityByCategory };
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

    const asAtDate = query.asAtDate ? new Date(query.asAtDate) : new Date();

    const current = await getBalances(ctx.actor.organizationId, asAtDate, query.currency);

    let comparative: typeof current | null = null;
    if (query.comparativeDate) {
      comparative = await getBalances(ctx.actor.organizationId, new Date(query.comparativeDate), query.currency);
    }

    const assets = ASSET_CATEGORIES.map(cat => ({
      category: cat,
      current: current.assetByCategory[cat] || 0,
      comparative: comparative?.assetByCategory[cat] || 0,
    })).filter(c => c.current !== 0 || c.comparative !== 0);

    const liabilities = LIABILITY_CATEGORIES.map(cat => ({
      category: cat,
      current: current.liabilityByCategory[cat] || 0,
      comparative: comparative?.liabilityByCategory[cat] || 0,
    })).filter(c => c.current !== 0 || c.comparative !== 0);

    const equity = EQUITY_CATEGORIES.map(cat => ({
      category: cat,
      current: current.equityByCategory[cat] || 0,
      comparative: comparative?.equityByCategory[cat] || 0,
    })).filter(c => c.current !== 0 || c.comparative !== 0);

    const totalAssets = assets.reduce((sum, c) => sum + c.current, 0);
    const totalLiabilities = liabilities.reduce((sum, c) => sum + c.current, 0);
    const totalEquity = equity.reduce((sum, c) => sum + c.current, 0);
    const compTotalAssets = assets.reduce((sum, c) => sum + c.comparative, 0);
    const compTotalLiabilities = liabilities.reduce((sum, c) => sum + c.comparative, 0);
    const compTotalEquity = equity.reduce((sum, c) => sum + c.comparative, 0);

    return ok({
      data: {
        assets,
        liabilities,
        equity,
        totals: {
          assets: { current: totalAssets, comparative: compTotalAssets },
          liabilities: { current: totalLiabilities, comparative: compTotalLiabilities },
          equity: { current: totalEquity, comparative: compTotalEquity },
        },
        balanced: { current: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.000001, comparative: Math.abs(compTotalAssets - (compTotalLiabilities + compTotalEquity)) < 0.000001 },
        asAtDate: query.asAtDate || new Date().toISOString(),
        comparativeDate: query.comparativeDate,
      },
    }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}