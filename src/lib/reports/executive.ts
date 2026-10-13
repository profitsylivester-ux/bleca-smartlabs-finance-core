import { prisma } from '@/lib/db/prisma';
import { anyUnverified } from './unverified';
import {
  contributionsFor,
  dec,
  ledgerLineWhere,
  loadUnverifiedByAccount,
  markUnverified,
  POSTED_STATUSES,
  resolveWindow,
  sumMarked,
  type Scope,
} from './internal';
import { CASH_SUBCATEGORIES } from './financial';
import type { MarkedAmount, ReportFilters, ReportResult, ReportRow } from './types';

/**
 * EXECUTIVE report builder (PDF Â§47).
 *
 * One function serves the monthly CEO, quarterly management and annual reports:
 * it composes the ledger P&L, cash, budget utilisation and compliance counts a
 * CEO needs on one page, carrying the unverified marker through so a partial
 * bootcamp figure can never be read as a closed result.
 */
export async function buildExecutive(
  ctx: unknown,
  scope: Scope,
  filters: ReportFilters,
  title: string,
  category: ReportResult['category'],
): Promise<ReportResult> {
  const currency = filters.currency ?? scope.baseCurrency;
  const window = await resolveWindow(scope.organizationId, filters);
  const unverified = await loadUnverifiedByAccount(scope.organizationId);

  const pnlLines = await prisma.journalLine.findMany({
    where: ledgerLineWhere(scope, window, filters, ['REVENUE', 'EXPENSE']),
    select: { accountId: true, debit: true, credit: true, account: { select: { type: true } } },
  });
  const revenueParts: MarkedAmount[] = [];
  const expenseParts: MarkedAmount[] = [];
  for (const line of pnlLines) {
    const contrib = contributionsFor(unverified, line.accountId);
    if (line.account.type === 'REVENUE') revenueParts.push(markUnverified(dec(line.credit).minus(dec(line.debit)), currency, contrib));
    else expenseParts.push(markUnverified(dec(line.debit).minus(dec(line.credit)), currency, contrib));
  }
  const totalRevenue = sumMarked(revenueParts, currency);
  const totalExpense = sumMarked(expenseParts, currency);
  const netResult: MarkedAmount = {
    amount: dec(totalRevenue.amount).minus(dec(totalExpense.amount)).toString(),
    currency,
    unverified: [...totalRevenue.unverified, ...totalExpense.unverified],
  };

  const asAt = window.endDate ?? new Date();
  const cashAgg = await prisma.journalLine.aggregate({
    where: {
      organizationId: scope.organizationId,
      account: { subCategory: { in: CASH_SUBCATEGORIES } },
      ...(filters.currency ? { currencyCode: filters.currency } : {}),
      entry: { status: { in: POSTED_STATUSES }, postedAt: { lte: asAt } },
    },
    _sum: { debit: true, credit: true },
  });
  const cash: MarkedAmount = { amount: dec(cashAgg._sum?.debit).minus(dec(cashAgg._sum?.credit)).toString(), currency, unverified: [] };

  const budgets = await prisma.budget.findMany({
    where: { organizationId: scope.organizationId, status: 'ACTIVE' },
    select: { approvedAmount: true, actualAmount: true, isOverBudget: true },
  });
  const approved = budgets.reduce((s, b) => s.plus(dec(b.approvedAmount)), dec(0));
  const actual = budgets.reduce((s, b) => s.plus(dec(b.actualAmount)), dec(0));
  const overBudgetCount = budgets.filter((b) => b.isOverBudget).length;

  const unverifiedRules = await prisma.taxRule.count({ where: { organizationId: scope.organizationId, isActive: true, isVerified: false } });
  const overdueObligations = await prisma.taxObligation.count({ where: { organizationId: scope.organizationId, status: { in: ['PENDING', 'FILED', 'OVERDUE'] }, filingDueDate: { lt: asAt } } });

  const money = (label: string, value: MarkedAmount): ReportRow => ({ id: label.toLowerCase().replace(/\s+/g, '-'), cells: { metric: label, value } });
  const text = (label: string, value: string): ReportRow => ({ id: label.toLowerCase().replace(/\s+/g, '-'), cells: { metric: label, value } });

  return {
    reportKey: reportKeyForCadence(filters.cadence),
    title, category,
    generatedAt: new Date().toISOString(), currency, filters,
    sections: [
      { key: 'performance', label: 'Financial performance', columns: [{ key: 'metric', label: 'Metric', type: 'text' }, { key: 'value', label: 'Value', type: 'amount', currency }], rows: [
        money('Total revenue', totalRevenue),
        money('Total expenses', totalExpense),
        money('Net result', netResult),
        money('Cash on hand', cash),
      ] },
      { key: 'budgets', label: 'Budget utilisation', columns: [{ key: 'metric', label: 'Metric', type: 'text' }, { key: 'value', label: 'Value', type: 'amount', currency }], rows: [
        money('Approved budget', { amount: approved.toString(), currency, unverified: [] }),
        money('Actual spend', { amount: actual.toString(), currency, unverified: [] }),
        text('Budgets over budget', String(overBudgetCount)),
      ] },
      { key: 'risk', label: 'Risk & compliance', columns: [{ key: 'metric', label: 'Metric', type: 'text' }, { key: 'value', label: 'Value', type: 'text' }], rows: [
        text('Unverified tax rules', String(unverifiedRules)),
        text('Overdue obligations', String(overdueObligations)),
        text('Report contains unverified figures', netResult.unverified.length > 0 ? 'YES â€” see marked figures' : 'No'),
      ] },
    ],
    checks: [],
    hasUnverified: anyUnverified([totalRevenue, totalExpense, netResult, cash]),
  };
}

function reportKeyForCadence(cadence: ReportFilters['cadence']): string {
  if (cadence === 'QUARTERLY') return 'executive-quarterly';
  if (cadence === 'ANNUAL') return 'executive-annual';
  return 'executive-monthly';
}

