import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { ValidationError } from '@/lib/kernel/errors';

interface CashPositionItem {
  treasuryAccountId: string;
  code: string;
  name: string;
  kind: string;
  currencyCode: string;
  isRestricted: boolean;
  fundingSource: { id: string; code: string; name: string; type: string } | null;
  balance: number;
  balanceInBaseCurrency: number;
  totalDebits: number;
  totalCredits: number;
  asOf: string;
}

interface ByCurrencyItem {
  currencyCode: string;
  totalBalance: number;
  accountCount: number;
}

interface ByKindItem {
  kind: string;
  totalBalance: number;
  accountCount: number;
}

export async function GET(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'CASH', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const { searchParams } = new URL(request.url);
    const currencyCode = searchParams.get('currencyCode');
    const kind = searchParams.get('kind');
    const asOf = searchParams.get('asOf') ? new Date(searchParams.get('asOf')!) : new Date();

    const treasuryAccounts = await prisma.treasuryAccount.findMany({
      where: {
        organizationId: ctx.actor.organizationId,
        isActive: true,
        ...(currencyCode ? { currencyCode } : {}),
        ...(kind ? { kind: kind as 'CASH' | 'BANK' | 'MOBILE_MONEY' | 'PAYMENT_GATEWAY' | 'PROJECT_FUND' | 'GRANT_FUND' | 'OTHER' } : {}),
      },
      select: {
        id: true,
        code: true,
        name: true,
        kind: true,
        currencyCode: true,
        ledgerAccountId: true,
        isRestricted: true,
        fundingSourceId: true,
        fundingSource: { select: { id: true, code: true, name: true, type: true } },
      },
    });

    const ledgerAccountIds = treasuryAccounts.map((a) => a.ledgerAccountId);

    const journalLines = await prisma.journalLine.findMany({
      where: {
        organizationId: ctx.actor.organizationId,
        accountId: { in: ledgerAccountIds },
        entry: { status: 'POSTED' },
      },
      select: {
        accountId: true,
        debit: true,
        credit: true,
        currencyCode: true,
        baseAmount: true,
        entry: { select: { postedAt: true } },
      },
    });

    const accountBalances = new Map<string, { debit: number; credit: number; baseDebit: number; baseCredit: number }>();

    for (const line of journalLines) {
      const postedAt = line.entry?.postedAt ? new Date(line.entry.postedAt) : new Date(0);
      if (postedAt > asOf) continue;

      const key = line.accountId;
      const existing = accountBalances.get(key) || { debit: 0, credit: 0, baseDebit: 0, baseCredit: 0 };
      existing.debit += Number(line.debit);
      existing.credit += Number(line.credit);
      existing.baseDebit += Number(line.baseAmount) * (Number(line.debit) > 0 ? 1 : 0);
      existing.baseCredit += Number(line.baseAmount) * (Number(line.credit) > 0 ? 1 : 0);
      accountBalances.set(key, existing);
    }

    const cashPositions: CashPositionItem[] = treasuryAccounts.map((account) => {
      const balances = accountBalances.get(account.ledgerAccountId) || { debit: 0, credit: 0, baseDebit: 0, baseCredit: 0 };
      const balance = balances.baseDebit - balances.baseCredit;
      return {
        treasuryAccountId: account.id,
        code: account.code,
        name: account.name,
        kind: account.kind,
        currencyCode: account.currencyCode,
        isRestricted: account.isRestricted,
        fundingSource: account.fundingSource,
        balance,
        balanceInBaseCurrency: balance,
        totalDebits: balances.debit,
        totalCredits: balances.credit,
        asOf: asOf.toISOString(),
      };
    });

    const byCurrencyMap = new Map<string, { totalBalance: number; accountCount: number }>();
    for (const pos of cashPositions) {
      const existing = byCurrencyMap.get(pos.currencyCode) || { totalBalance: 0, accountCount: 0 };
      existing.totalBalance += pos.balanceInBaseCurrency;
      existing.accountCount += 1;
      byCurrencyMap.set(pos.currencyCode, existing);
    }

    const byKindMap = new Map<string, { totalBalance: number; accountCount: number }>();
    for (const pos of cashPositions) {
      const existing = byKindMap.get(pos.kind) || { totalBalance: 0, accountCount: 0 };
      existing.totalBalance += pos.balanceInBaseCurrency;
      existing.accountCount += 1;
      byKindMap.set(pos.kind, existing);
    }

    const byCurrency: ByCurrencyItem[] = Array.from(byCurrencyMap.entries()).map(([currencyCode, data]) => ({
      currencyCode,
      totalBalance: data.totalBalance,
      accountCount: data.accountCount,
    }));

    const byKind: ByKindItem[] = Array.from(byKindMap.entries()).map(([kind, data]) => ({
      kind,
      totalBalance: data.totalBalance,
      accountCount: data.accountCount,
    }));

    return ok({
      data: {
        positions: cashPositions,
        byCurrency,
        byKind,
        grandTotal: cashPositions.reduce((sum, p) => sum + p.balanceInBaseCurrency, 0),
        asOf: asOf.toISOString(),
      },
    }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}