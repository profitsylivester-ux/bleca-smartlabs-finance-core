import { Prisma, type AccountSubCategory } from '@/generated/prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '@/lib/db/prisma';
import { anyUnverified } from './unverified';
import {
  contributionsFor,
  dec,
  dimensionWhere,
  ledgerLineWhere,
  loadUnverifiedByAccount,
  markUnverified,
  POSTED_STATUSES,
  resolveWindow,
  sumMarked,
  type Scope,
} from './internal';
import type { MarkedAmount, ReportColumn, ReportFilters, ReportResult, ReportRow } from './types';

/**
 * FINANCIAL report builders (PDF §47). Each returns a GL-consistent
 * ReportResult whose totals tie to JournalLine and whose unverified figures are
 * marked via markUnverified (PDF §2).
 */

export const REVENUE_CATEGORIES = [
  'REVENUE_TRAINING', 'REVENUE_CONSULTING', 'REVENUE_SOFTWARE', 'REVENUE_SAAS',
  'REVENUE_AI_SERVICES', 'REVENUE_IOT_SERVICES', 'REVENUE_HARDWARE', 'REVENUE_ELECTRONICS',
  'REVENUE_COMPONENT_SALES', 'REVENUE_SUBSCRIPTION', 'REVENUE_TOKEN_PACKAGES', 'REVENUE_OTHER',
];
export const EXPENSE_CATEGORIES = [
  'EXPENSE_INTERNET', 'EXPENSE_CLOUD', 'EXPENSE_AI_API', 'EXPENSE_TRANSPORT',
  'EXPENSE_MARKETING', 'EXPENSE_SOFTWARE', 'EXPENSE_WORKSPACE', 'EXPENSE_SALARIES',
  'EXPENSE_TRAINING', 'EXPENSE_HARDWARE_PROTOTYPING', 'EXPENSE_OTHER',
];
export const ASSET_CATEGORIES = ['CASH', 'BANK', 'MOBILE_MONEY', 'RECEIVABLE', 'INVENTORY', 'EQUIPMENT', 'OTHER_ASSET'];
export const LIABILITY_CATEGORIES = ['SUPPLIER_PAYABLE', 'TAX_PAYABLE', 'LOAN', 'ACCRUED_EXPENSE', 'OTHER_OBLIGATION'];
export const EQUITY_CATEGORIES = ['CAPITAL', 'RETAINED_EARNINGS', 'FUTURE_INVESTMENT'];
export const CASH_SUBCATEGORIES: AccountSubCategory[] = ['CASH', 'BANK', 'MOBILE_MONEY'];

export async function buildIncomeStatement(
  ctx: unknown,
  scope: Scope,
  filters: ReportFilters,
  title: string,
  category: ReportResult['category'],
): Promise<ReportResult> {
  const currency = filters.currency ?? scope.baseCurrency;
  const window = await resolveWindow(scope.organizationId, filters);
  const unverified = await loadUnverifiedByAccount(scope.organizationId);

  const lines = await prisma.journalLine.findMany({
    where: ledgerLineWhere(scope, window, filters, ['REVENUE', 'EXPENSE']),
    select: { accountId: true, debit: true, credit: true, account: { select: { type: true, subCategory: true } } },
  });

  const revenueByCategory = new Map<string, MarkedAmount[]>();
  const expenseByCategory = new Map<string, MarkedAmount[]>();
  for (const line of lines) {
    const cat = line.account.subCategory ?? 'UNCATEGORIZED';
    const amount = line.account.type === 'REVENUE'
      ? dec(line.credit).minus(dec(line.debit))
      : dec(line.debit).minus(dec(line.credit));
    const marked = markUnverified(amount, currency, contributionsFor(unverified, line.accountId));
    const target = line.account.type === 'REVENUE' ? revenueByCategory : expenseByCategory;
    target.set(cat, [...(target.get(cat) ?? []), marked]);
  }

  const revenueRows: ReportRow[] = REVENUE_CATEGORIES.filter((c) => revenueByCategory.has(c)).map((c) => ({
    id: c, cells: { category: c.replace(/_/g, ' '), amount: sumMarked(revenueByCategory.get(c) ?? [], currency) },
  }));
  const expenseRows: ReportRow[] = EXPENSE_CATEGORIES.filter((c) => expenseByCategory.has(c)).map((c) => ({
    id: c, cells: { category: c.replace(/_/g, ' '), amount: sumMarked(expenseByCategory.get(c) ?? [], currency) },
  }));

  const totalRevenue = sumMarked(revenueRows.map((r) => r.cells.amount as MarkedAmount), currency);
  const totalExpense = sumMarked(expenseRows.map((r) => r.cells.amount as MarkedAmount), currency);
  const netResult: MarkedAmount = {
    amount: dec(totalRevenue.amount).minus(dec(totalExpense.amount)).toString(),
    currency,
    unverified: [...totalRevenue.unverified, ...totalExpense.unverified],
  };

  const cols: ReportColumn[] = [
    { key: 'category', label: 'Category', type: 'text' },
    { key: 'amount', label: 'Amount', type: 'amount', currency },
  ];

  return {
    reportKey: 'income-statement', title, category,
    generatedAt: new Date().toISOString(), currency, filters,
    sections: [
      { key: 'revenue', label: 'Revenue', columns: cols, rows: revenueRows, subtotal: { amount: totalRevenue } },
      { key: 'expense', label: 'Expenses', columns: cols, rows: expenseRows, subtotal: { amount: totalExpense } },
      { key: 'net', label: 'Net surplus / (deficit)', columns: cols, rows: [{ id: 'net', cells: { category: 'Net result', amount: netResult } }] },
    ],
    checks: [{ key: 'pn-defined', label: 'Net result equals revenue minus expenses', passed: true, detail: `Revenue ${totalRevenue.amount} − expenses ${totalExpense.amount} = ${netResult.amount}` }],
    hasUnverified: anyUnverified([totalRevenue, totalExpense, netResult]),
  };
}

export async function buildBalanceSheet(
  ctx: unknown,
  scope: Scope,
  filters: ReportFilters,
  title: string,
  category: ReportResult['category'],
): Promise<ReportResult> {
  const currency = filters.currency ?? scope.baseCurrency;
  const asAt = filters.asAtDate ? new Date(filters.asAtDate) : new Date();
  const unverified = await loadUnverifiedByAccount(scope.organizationId);

  const where: Prisma.JournalLineWhereInput = {
    organizationId: scope.organizationId,
    account: { type: { in: ['ASSET', 'LIABILITY', 'EQUITY'] } },
    ...(filters.currency ? { currencyCode: filters.currency } : {}),
    ...dimensionWhere(filters),
    entry: { status: { in: POSTED_STATUSES }, postedAt: { lte: asAt } },
  };
  const lines = await prisma.journalLine.findMany({
    where,
    select: { accountId: true, debit: true, credit: true, account: { select: { type: true, subCategory: true, normalBalance: true } } },
  });

  const buckets: Record<string, Map<string, MarkedAmount[]>> = { ASSET: new Map(), LIABILITY: new Map(), EQUITY: new Map() };
  for (const line of lines) {
    const cat = line.account.subCategory ?? 'UNCATEGORIZED';
    const balance = line.account.normalBalance === 'DEBIT'
      ? dec(line.debit).minus(dec(line.credit))
      : dec(line.credit).minus(dec(line.debit));
    const marked = markUnverified(balance, currency, contributionsFor(unverified, line.accountId));
    const bucket = buckets[line.account.type];
    if (bucket) bucket.set(cat, [...(bucket.get(cat) ?? []), marked]);
  }

  const makeRows = (categories: string[], bucket: Map<string, MarkedAmount[]>): ReportRow[] =>
    categories.filter((c) => bucket.has(c)).map((c) => ({ id: c, cells: { category: c.replace(/_/g, ' '), amount: sumMarked(bucket.get(c) ?? [], currency) } }));

  const assetRows = makeRows(ASSET_CATEGORIES, buckets.ASSET!);
  const liabilityRows = makeRows(LIABILITY_CATEGORIES, buckets.LIABILITY!);
  const equityRows = makeRows(EQUITY_CATEGORIES, buckets.EQUITY!);
  const totalAssets = sumMarked(assetRows.map((r) => r.cells.amount as MarkedAmount), currency);
  const totalLiabilities = sumMarked(liabilityRows.map((r) => r.cells.amount as MarkedAmount), currency);
  const totalEquity = sumMarked(equityRows.map((r) => r.cells.amount as MarkedAmount), currency);
  const lPlusE = dec(totalLiabilities.amount).plus(dec(totalEquity.amount));
  const balanced = totalAssets.amount === lPlusE.toString();

  const cols: ReportColumn[] = [
    { key: 'category', label: 'Category', type: 'text' },
    { key: 'amount', label: 'Amount', type: 'amount', currency },
  ];

  return {
    reportKey: 'balance-sheet', title, category,
    generatedAt: new Date().toISOString(), currency, filters,
    sections: [
      { key: 'assets', label: 'Assets', columns: cols, rows: assetRows, subtotal: { amount: totalAssets } },
      { key: 'liabilities', label: 'Liabilities', columns: cols, rows: liabilityRows, subtotal: { amount: totalLiabilities } },
      { key: 'equity', label: 'Equity', columns: cols, rows: equityRows, subtotal: { amount: totalEquity } },
    ],
    checks: [{ key: 'balance', label: 'Assets = Liabilities + Equity', passed: balanced, detail: `Assets ${totalAssets.amount} vs Liabilities + Equity ${lPlusE.toString()}` }],
    hasUnverified: anyUnverified([totalAssets, totalLiabilities, totalEquity]),
  };
}

export async function buildTrialBalance(
  ctx: unknown,
  scope: Scope,
  filters: ReportFilters,
  title: string,
  category: ReportResult['category'],
): Promise<ReportResult> {
  const currency = filters.currency ?? scope.baseCurrency;
  const window = await resolveWindow(scope.organizationId, filters);
  const unverified = await loadUnverifiedByAccount(scope.organizationId);

  const lines = await prisma.journalLine.findMany({
    where: ledgerLineWhere(scope, window, filters),
    select: { accountId: true, debit: true, credit: true, account: { select: { code: true, name: true, type: true } } },
  });

  const byAccount = new Map<string, { code: string; name: string; type: string; debit: Decimal; credit: Decimal }>();
  for (const line of lines) {
    const entry = byAccount.get(line.accountId) ?? { code: line.account.code, name: line.account.name, type: line.account.type, debit: dec(0), credit: dec(0) };
    entry.debit = entry.debit.plus(dec(line.debit));
    entry.credit = entry.credit.plus(dec(line.credit));
    byAccount.set(line.accountId, entry);
  }

  const rows: ReportRow[] = [...byAccount.entries()].sort((a, b) => a[1].code.localeCompare(b[1].code)).map(([accountId, a]) => ({
    id: accountId,
    cells: {
      code: a.code, account: a.name, type: a.type,
      debit: markUnverified(a.debit, currency, contributionsFor(unverified, accountId)),
      credit: markUnverified(a.credit, currency, contributionsFor(unverified, accountId)),
    },
  }));

  const totalDebit = rows.reduce((s, r) => s.plus(dec((r.cells.debit as MarkedAmount).amount)), dec(0));
  const totalCredit = rows.reduce((s, r) => s.plus(dec((r.cells.credit as MarkedAmount).amount)), dec(0));
  const balanced = totalDebit.equals(totalCredit);

  const cols: ReportColumn[] = [
    { key: 'code', label: 'Code', type: 'text' },
    { key: 'account', label: 'Account', type: 'text' },
    { key: 'type', label: 'Type', type: 'text' },
    { key: 'debit', label: 'Debit', type: 'amount', currency },
    { key: 'credit', label: 'Credit', type: 'amount', currency },
  ];

  return {
    reportKey: 'trial-balance', title, category,
    generatedAt: new Date().toISOString(), currency, filters,
    sections: [{ key: 'trial-balance', label: 'Trial balance', columns: cols, rows, subtotal: { debit: markUnverified(totalDebit, currency, []), credit: markUnverified(totalCredit, currency, []) } }],
    checks: [{ key: 'debits-equal-credits', label: 'Total debits equal total credits', passed: balanced, detail: `Debits ${totalDebit.toString()} vs credits ${totalCredit.toString()}` }],
    hasUnverified: rows.some((r) => (r.cells.debit as MarkedAmount).unverified.length > 0 || (r.cells.credit as MarkedAmount).unverified.length > 0),
  };
}
