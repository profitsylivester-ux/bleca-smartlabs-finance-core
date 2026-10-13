import { Prisma } from '@/generated/prisma/client';
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
import type { MarkedAmount, ReportColumn, ReportFilters, ReportResult, ReportRow } from './types';

/** MANAGEMENT report builders (PDF Â§47). */

/**
 * Budget vs Actual. Uses the SAME availability engine (`recomputeAvailability`)
 * the budgets module uses, so this report's actual/committed/available figures
 * are, by construction, equal to the budget availability computation â€” the exact
 * tie asserted by the integration test.
 */
export async function buildBudgetVsActual(
  ctx: unknown,
  scope: Scope,
  filters: ReportFilters,
  title: string,
  category: ReportResult['category'],
): Promise<ReportResult> {
  const currency = filters.currency ?? scope.baseCurrency;
  const budgets = await prisma.budget.findMany({
    where: {
      organizationId: scope.organizationId,
      ...(filters.projectId ? { projectId: filters.projectId } : {}),
      ...(filters.departmentId ? { departmentId: filters.departmentId } : {}),
      ...(filters.fundingSourceId ? { fundingSourceId: filters.fundingSourceId } : {}),
      ...(filters.costCentreId ? { costCentreId: filters.costCentreId } : {}),
    },
    orderBy: { code: 'asc' },
  });

  const { recomputeAvailability } = await import('@/lib/budgets/availability');
  const rows: ReportRow[] = [];
  for (const budget of budgets) {
    const availability = await prisma.$transaction((tx) => recomputeAvailability(tx, budget.id));
    rows.push({
      id: budget.id,
      cells: {
        budget: `${budget.code} ${budget.name}`,
        status: budget.status,
        approved: { amount: availability.approved.toString(), currency: budget.currencyCode, unverified: [] },
        committed: { amount: availability.committed.toString(), currency: budget.currencyCode, unverified: [] },
        actual: { amount: availability.actual.toString(), currency: budget.currencyCode, unverified: [] },
        available: { amount: availability.available.toString(), currency: budget.currencyCode, unverified: [] },
        overBudget: availability.isOverBudget,
      },
    });
  }

  const cols: ReportColumn[] = [
    { key: 'budget', label: 'Budget', type: 'text' },
    { key: 'status', label: 'Status', type: 'badge' },
    { key: 'approved', label: 'Approved', type: 'amount', currency },
    { key: 'committed', label: 'Committed', type: 'amount', currency },
    { key: 'actual', label: 'Actual', type: 'amount', currency },
    { key: 'available', label: 'Available', type: 'amount', currency },
    { key: 'overBudget', label: 'Over budget', type: 'badge' },
  ];

  return {
    reportKey: 'budget-vs-actual', title, category,
    generatedAt: new Date().toISOString(), currency, filters,
    sections: [{ key: 'budgets', label: 'Budget vs actual', columns: cols, rows }],
    checks: [], hasUnverified: false,
  };
}

/** Project profitability via the project dimension. */
export async function buildProjectProfitability(
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
    select: {
      accountId: true, debit: true, credit: true, projectId: true,
      account: { select: { type: true } },
      project: { select: { id: true, code: true, name: true } },
    },
  });

  const byProject = new Map<string, { code: string; name: string; revenue: MarkedAmount[]; expense: MarkedAmount[] }>();
  for (const line of lines) {
    const projectId = line.projectId ?? 'unassigned';
    const entry = byProject.get(projectId) ?? { code: line.project?.code ?? 'Unassigned', name: line.project?.name ?? 'No project', revenue: [], expense: [] };
    const contrib = contributionsFor(unverified, line.accountId);
    if (line.account.type === 'REVENUE') entry.revenue.push(markUnverified(dec(line.credit).minus(dec(line.debit)), currency, contrib));
    else entry.expense.push(markUnverified(dec(line.debit).minus(dec(line.credit)), currency, contrib));
    byProject.set(projectId, entry);
  }

  const rows: ReportRow[] = [...byProject.entries()].map(([projectId, p]) => {
    const revenue = sumMarked(p.revenue, currency);
    const expense = sumMarked(p.expense, currency);
    const net: MarkedAmount = {
      amount: dec(revenue.amount).minus(dec(expense.amount)).toString(),
      currency,
      unverified: [...revenue.unverified, ...expense.unverified],
    };
    return { id: projectId, cells: { project: `${p.code} ${p.name}`, revenue, expense, net } };
  });

  const cols: ReportColumn[] = [
    { key: 'project', label: 'Project', type: 'text' },
    { key: 'revenue', label: 'Revenue', type: 'amount', currency },
    { key: 'expense', label: 'Expense', type: 'amount', currency },
    { key: 'net', label: 'Net result', type: 'amount', currency },
  ];

  return {
    reportKey: 'project-profitability', title, category,
    generatedAt: new Date().toISOString(), currency, filters,
    sections: [{ key: 'projects', label: 'Project profitability', columns: cols, rows }],
    checks: [],
    hasUnverified: rows.some((r) => (r.cells.net as MarkedAmount).unverified.length > 0),
  };
}

/** Revenue analysis by category. */
export async function buildRevenueAnalysis(
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
    where: ledgerLineWhere(scope, window, filters, ['REVENUE']),
    select: { accountId: true, debit: true, credit: true, account: { select: { subCategory: true } } },
  });

  const byCategory = new Map<string, MarkedAmount[]>();
  for (const line of lines) {
    const cat = line.account.subCategory ?? 'UNCATEGORIZED';
    byCategory.set(cat, [...(byCategory.get(cat) ?? []), markUnverified(dec(line.credit).minus(dec(line.debit)), currency, contributionsFor(unverified, line.accountId))]);
  }

  const rows: ReportRow[] = [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([cat, parts]) => ({
    id: cat, cells: { category: cat.replace(/_/g, ' '), amount: sumMarked(parts, currency) },
  }));
  const total = sumMarked(rows.map((r) => r.cells.amount as MarkedAmount), currency);

  return {
    reportKey: 'revenue-analysis', title, category,
    generatedAt: new Date().toISOString(), currency, filters,
    sections: [{ key: 'revenue', label: 'Revenue by category', columns: [{ key: 'category', label: 'Revenue category', type: 'text' }, { key: 'amount', label: 'Amount', type: 'amount', currency }], rows, subtotal: { amount: total } }],
    checks: [], hasUnverified: anyUnverified([total]),
  };
}

/** Expense analysis by category and cost centre (both must sum to the same total). */
export async function buildExpenseAnalysis(
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
    where: ledgerLineWhere(scope, window, filters, ['EXPENSE']),
    select: { accountId: true, debit: true, credit: true, account: { select: { subCategory: true } }, costCentre: { select: { code: true, name: true } } },
  });

  const byCategory = new Map<string, MarkedAmount[]>();
  const byCostCentre = new Map<string, MarkedAmount[]>();
  for (const line of lines) {
    const amount = dec(line.debit).minus(dec(line.credit));
    const contrib = contributionsFor(unverified, line.accountId);
    const cat = line.account.subCategory ?? 'UNCATEGORIZED';
    byCategory.set(cat, [...(byCategory.get(cat) ?? []), markUnverified(amount, currency, contrib)]);
    const cc = line.costCentre ? `${line.costCentre.code} ${line.costCentre.name}` : 'Unassigned';
    byCostCentre.set(cc, [...(byCostCentre.get(cc) ?? []), markUnverified(amount, currency, contrib)]);
  }

  const catRows: ReportRow[] = [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([cat, parts]) => ({ id: cat, cells: { category: cat.replace(/_/g, ' '), amount: sumMarked(parts, currency) } }));
  const ccRows: ReportRow[] = [...byCostCentre.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([cc, parts]) => ({ id: cc, cells: { costCentre: cc, amount: sumMarked(parts, currency) } }));
  const catTotal = sumMarked(catRows.map((r) => r.cells.amount as MarkedAmount), currency);
  const ccTotal = sumMarked(ccRows.map((r) => r.cells.amount as MarkedAmount), currency);

  return {
    reportKey: 'expense-analysis', title, category,
    generatedAt: new Date().toISOString(), currency, filters,
    sections: [
      { key: 'by-category', label: 'Expenses by category', columns: [{ key: 'category', label: 'Category', type: 'text' }, { key: 'amount', label: 'Amount', type: 'amount', currency }], rows: catRows, subtotal: { amount: catTotal } },
      { key: 'by-cost-centre', label: 'Expenses by cost centre', columns: [{ key: 'costCentre', label: 'Cost centre', type: 'text' }, { key: 'amount', label: 'Amount', type: 'amount', currency }], rows: ccRows, subtotal: { amount: ccTotal } },
    ],
    checks: [{ key: 'category-equals-costcentre', label: 'Category total equals cost-centre total', passed: catTotal.amount === ccTotal.amount, detail: `${catTotal.amount} vs ${ccTotal.amount}` }],
    hasUnverified: anyUnverified([catTotal, ccTotal]),
  };
}

/** Cash position: balances across every treasury account by kind and currency. */
export async function buildCashPosition(
  ctx: unknown,
  scope: Scope,
  filters: ReportFilters,
  title: string,
  category: ReportResult['category'],
): Promise<ReportResult> {
  const asOf = filters.asAtDate ? new Date(filters.asAtDate) : new Date();
  const accounts = await prisma.treasuryAccount.findMany({
    where: { organizationId: scope.organizationId, isActive: true, ...(filters.currency ? { currencyCode: filters.currency } : {}) },
    select: { id: true, code: true, name: true, kind: true, currencyCode: true, ledgerAccountId: true, isRestricted: true, fundingSource: { select: { code: true } } },
    orderBy: { code: 'asc' },
  });

  const lines = await prisma.journalLine.findMany({
    where: {
      organizationId: scope.organizationId,
      accountId: { in: accounts.map((a) => a.ledgerAccountId) },
      entry: { status: { in: POSTED_STATUSES }, postedAt: { lte: asOf } },
    },
    select: { accountId: true, debit: true, credit: true },
  });
  const balances = new Map<string, ReturnType<typeof dec>>();
  for (const line of lines) {
    balances.set(line.accountId, (balances.get(line.accountId) ?? dec(0)).plus(dec(line.debit).minus(dec(line.credit))));
  }

  const rows: ReportRow[] = accounts.map((a) => ({
    id: a.id,
    cells: {
      account: `${a.code} ${a.name}`,
      kind: a.kind,
      currency: a.currencyCode,
      funding: a.fundingSource?.code ?? 'â€”',
      restricted: a.isRestricted,
      balance: { amount: (balances.get(a.ledgerAccountId) ?? dec(0)).toString(), currency: a.currencyCode, unverified: [] },
    },
  }));

  return {
    reportKey: 'cash-position', title, category,
    generatedAt: new Date().toISOString(), currency: filters.currency ?? scope.baseCurrency, filters,
    sections: [{ key: 'cash', label: 'Cash position', columns: [
      { key: 'account', label: 'Treasury account', type: 'text' },
      { key: 'kind', label: 'Kind', type: 'badge' },
      { key: 'currency', label: 'Currency', type: 'text' },
      { key: 'funding', label: 'Funding source', type: 'text' },
      { key: 'restricted', label: 'Restricted', type: 'badge' },
      { key: 'balance', label: 'Balance', type: 'amount' },
    ], rows }],
    checks: [], hasUnverified: false,
  };
}

/** Runway & burn rate: average monthly net burn and months of runway at cash. */
export async function buildRunwayBurn(
  ctx: unknown,
  scope: Scope,
  filters: ReportFilters,
  title: string,
  category: ReportResult['category'],
): Promise<ReportResult> {
  const currency = filters.currency ?? scope.baseCurrency;
  const window = await resolveWindow(scope.organizationId, filters);
  const end = window.endDate ?? new Date();
  const start = window.startDate ?? new Date(new Date(end).setMonth(end.getMonth() - 12));
  const months = Math.max(1, Math.round((end.getTime() - start.getTime()) / (30.44 * 86_400_000)));

  const lines = await prisma.journalLine.findMany({
    where: ledgerLineWhere(scope, { startDate: start, endDate: end }, filters, ['REVENUE', 'EXPENSE']),
    select: { debit: true, credit: true, account: { select: { type: true } } },
  });
  let revenue = dec(0);
  let expense = dec(0);
  for (const line of lines) {
    if (line.account.type === 'REVENUE') revenue = revenue.plus(dec(line.credit).minus(dec(line.debit)));
    else expense = expense.plus(dec(line.debit).minus(dec(line.credit)));
  }
  const netBurn = expense.minus(revenue);
  const monthlyBurn = netBurn.div(months);

  const cash = await prisma.journalLine.aggregate({
    where: {
      organizationId: scope.organizationId,
      account: { subCategory: { in: CASH_SUBCATEGORIES } },
      ...(filters.currency ? { currencyCode: filters.currency } : {}),
      entry: { status: { in: POSTED_STATUSES }, postedAt: { lte: end } },
    },
    _sum: { debit: true, credit: true },
  });
  const cashBalance = dec(cash._sum?.debit).minus(dec(cash._sum?.credit));
  const runwayMonths = monthlyBurn.greaterThan(0) ? cashBalance.div(monthlyBurn) : dec(0);

  const kpi = (label: string, value: ReturnType<typeof dec>): ReportRow => ({
    id: label.toLowerCase().replace(/\s+/g, '-'),
    cells: { metric: label, value: { amount: value.toString(), currency, unverified: [] } },
  });

  return {
    reportKey: 'runway-burn', title, category,
    generatedAt: new Date().toISOString(), currency, filters,
    sections: [{ key: 'runway', label: `Over ${months} month(s)`, columns: [{ key: 'metric', label: 'Metric', type: 'text' }, { key: 'value', label: 'Value', type: 'amount', currency }], rows: [
      kpi('Total revenue', revenue),
      kpi('Total expense', expense),
      kpi('Net burn', netBurn),
      kpi('Average monthly burn', monthlyBurn),
      kpi('Cash on hand', cashBalance),
      kpi('Months of runway', runwayMonths),
    ] }],
    checks: [], hasUnverified: false,
  };
}

/** Financial KPIs: current ratio, net margin, expense ratio. */
export async function buildFinancialKpis(
  ctx: unknown,
  scope: Scope,
  filters: ReportFilters,
  title: string,
  category: ReportResult['category'],
): Promise<ReportResult> {
  const currency = filters.currency ?? scope.baseCurrency;
  const window = await resolveWindow(scope.organizationId, filters);
  const asAt = window.endDate ?? new Date();

  const bsLines = await prisma.journalLine.findMany({
    where: {
      organizationId: scope.organizationId,
      account: { type: { in: ['ASSET', 'LIABILITY'] } },
      ...(filters.currency ? { currencyCode: filters.currency } : {}),
      entry: { status: { in: POSTED_STATUSES }, postedAt: { lte: asAt } },
    },
    select: { debit: true, credit: true, account: { select: { type: true } } },
  });
  let currentAssets = dec(0);
  let totalLiabilities = dec(0);
  for (const line of bsLines) {
    const net = dec(line.debit).minus(dec(line.credit));
    if (line.account.type === 'ASSET') currentAssets = currentAssets.plus(net);
    else totalLiabilities = totalLiabilities.plus(net.negated());
  }

  const pnl = await prisma.journalLine.findMany({
    where: ledgerLineWhere(scope, window, filters, ['REVENUE', 'EXPENSE']),
    select: { debit: true, credit: true, account: { select: { type: true } } },
  });
  let revenue = dec(0);
  let expense = dec(0);
  for (const line of pnl) {
    if (line.account.type === 'REVENUE') revenue = revenue.plus(dec(line.credit).minus(dec(line.debit)));
    else expense = expense.plus(dec(line.debit).minus(dec(line.credit)));
  }
  const netResult = revenue.minus(expense);
  const currentRatio = totalLiabilities.greaterThan(0) ? currentAssets.div(totalLiabilities) : dec(0);
  const netMargin = revenue.greaterThan(0) ? netResult.div(revenue).times(100) : dec(0);
  const expenseRatio = revenue.greaterThan(0) ? expense.div(revenue).times(100) : dec(0);

  const money = (label: string, value: ReturnType<typeof dec>): ReportRow => ({ id: label.toLowerCase().replace(/\s+/g, '-'), cells: { metric: label, value: { amount: value.toString(), currency, unverified: [] } } });
  const ratio = (label: string, value: ReturnType<typeof dec>, suffix: string): ReportRow => ({ id: label.toLowerCase().replace(/\s+/g, '-'), cells: { metric: label, value: `${value.toFixed(2)}${suffix}` } });

  return {
    reportKey: 'financial-kpis', title, category,
    generatedAt: new Date().toISOString(), currency, filters,
    sections: [{ key: 'kpis', label: 'Financial KPIs', columns: [{ key: 'metric', label: 'Metric', type: 'text' }, { key: 'value', label: 'Value', type: 'amount', currency }], rows: [
      money('Total revenue', revenue),
      money('Total expense', expense),
      money('Net result', netResult),
      money('Current assets', currentAssets),
      money('Total liabilities', totalLiabilities),
      ratio('Current ratio', currentRatio, 'x'),
      ratio('Net margin', netMargin, '%'),
      ratio('Expense ratio', expenseRatio, '%'),
    ] }],
    checks: [], hasUnverified: false,
  };
}

