import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';

const querySchema = z.object({
  asAtDate: z.string().datetime().optional(),
  currency: z.string().length(3).optional(),
  includeZeroBalances: z.coerce.boolean().default(false),
  periodId: z.string().cuid().optional(),
  groupBy: z.enum(['account', 'type', 'subcategory']).default('account'),
});

export async function GET(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'TRIAL_BALANCE', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new Error('No organization context'), reqId);
    }

    const url = new URL(request.url);
    const query = querySchema.parse(Object.fromEntries(url.searchParams));

    const asAtDate = query.asAtDate ? new Date(query.asAtDate) : new Date();

    const accounts = await prisma.account.findMany({
      where: { organizationId: ctx.actor.organizationId, isPostable: true, status: 'ACTIVE' },
      select: { id: true, code: true, name: true, type: true, subCategory: true, normalBalance: true },
    });

    const results = [];

    for (const account of accounts) {
      const where: Record<string, unknown> = {
        organizationId: ctx.actor.organizationId,
        accountId: account.id,
        entry: { postedAt: { lte: asAtDate }, status: { in: ['POSTED', 'LOCKED'] } },
      };
      if (query.currency) where.currencyCode = query.currency;
      if (query.periodId) where.periodId = query.periodId;

      const lines = await prisma.journalLine.findMany({
        where,
        select: { debit: true, credit: true, baseAmount: true, currencyCode: true },
      });

      const debit = lines.reduce((sum, l) => sum + Number(l.debit), 0);
      const credit = lines.reduce((sum, l) => sum + Number(l.credit), 0);
      const baseDebit = lines.reduce((sum, l) => sum + Number(l.baseAmount ?? l.debit), 0);
      const baseCredit = lines.reduce((sum, l) => sum + Number(l.baseAmount ?? l.credit), 0);

      if (!query.includeZeroBalances && debit === 0 && credit === 0) continue;

      results.push({
        accountId: account.id,
        accountCode: account.code,
        accountName: account.name,
        accountType: account.type,
        subCategory: account.subCategory,
        normalBalance: account.normalBalance,
        debit,
        credit,
        balance: debit - credit,
        baseCurrencyDebit: baseDebit,
        baseCurrencyCredit: baseCredit,
        baseCurrencyBalance: baseDebit - baseCredit,
      });
    }

    const totalDebit = results.reduce((sum, r) => sum + r.debit, 0);
    const totalCredit = results.reduce((sum, r) => sum + r.credit, 0);
    const totalBaseDebit = results.reduce((sum, r) => sum + r.baseCurrencyDebit, 0);
    const totalBaseCredit = results.reduce((sum, r) => sum + r.baseCurrencyCredit, 0);

    if (query.groupBy === 'type') {
      const grouped = results.reduce((acc, r) => {
        const key = r.accountType;
        if (!acc[key]) {
          acc[key] = { accountType: key, accounts: [], totalDebit: 0, totalCredit: 0, totalBaseDebit: 0, totalBaseCredit: 0 };
        }
        acc[key].accounts.push(r);
        acc[key].totalDebit += r.debit;
        acc[key].totalCredit += r.credit;
        acc[key].totalBaseDebit += r.baseCurrencyDebit;
        acc[key].totalBaseCredit += r.baseCurrencyCredit;
        return acc;
      }, {} as Record<string, { accountType: string; accounts: typeof results; totalDebit: number; totalCredit: number; totalBaseDebit: number; totalBaseCredit: number }>);

      return ok({ data: Object.values(grouped), totals: { totalDebit, totalCredit, totalBaseDebit, totalBaseCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.000001 } }, 200, reqId);
    }

    if (query.groupBy === 'subcategory') {
      const grouped = results.reduce((acc, r) => {
        const key = r.subCategory ?? 'UNCATEGORIZED';
        if (!acc[key]) {
          acc[key] = { subCategory: key, accounts: [], totalDebit: 0, totalCredit: 0, totalBaseDebit: 0, totalBaseCredit: 0 };
        }
        acc[key].accounts.push(r);
        acc[key].totalDebit += r.debit;
        acc[key].totalCredit += r.credit;
        acc[key].totalBaseDebit += r.baseCurrencyDebit;
        acc[key].totalBaseCredit += r.baseCurrencyCredit;
        return acc;
      }, {} as Record<string, { subCategory: string; accounts: typeof results; totalDebit: number; totalCredit: number; totalBaseDebit: number; totalBaseCredit: number }>);

      return ok({ data: Object.values(grouped), totals: { totalDebit, totalCredit, totalBaseDebit, totalBaseCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.000001 } }, 200, reqId);
    }

    return ok({ data: results, totals: { totalDebit, totalCredit, totalBaseDebit, totalBaseCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.000001 } }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}