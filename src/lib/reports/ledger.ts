import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '@/lib/db/prisma';
import {
  CASH_SUBCATEGORIES,
} from './financial';
import {
  dec,
  ledgerLineWhere,
  markUnverified,
  POSTED_STATUSES,
  resolveWindow,
  type Scope,
} from './internal';
import type { MarkedAmount, ReportColumn, ReportFilters, ReportResult, ReportRow } from './types';

/** Ledger-detail FINANCIAL builders (PDF Â§47): GL, cash flow, aging, reconciliation. */

export async function buildGeneralLedger(
  ctx: unknown,
  scope: Scope,
  filters: ReportFilters,
  title: string,
  category: ReportResult['category'],
): Promise<ReportResult> {
  const currency = filters.currency ?? scope.baseCurrency;
  const window = await resolveWindow(scope.organizationId, filters);

  const lines = await prisma.journalLine.findMany({
    where: ledgerLineWhere(scope, window, filters),
    select: {
      id: true, debit: true, credit: true, currencyCode: true,
      entry: { select: { number: true, postedAt: true, description: true } },
      account: { select: { code: true, name: true } },
    },
    orderBy: [{ entry: { postedAt: 'asc' } }, { lineNumber: 'asc' }],
  });

  let running = dec(0);
  const rows: ReportRow[] = lines.map((line) => {
    running = running.plus(dec(line.debit)).minus(dec(line.credit));
    return {
      id: line.id,
      cells: {
        date: line.entry.postedAt ? line.entry.postedAt.toISOString().slice(0, 10) : '',
        entry: line.entry.number ?? '',
        account: `${line.account.code} ${line.account.name}`,
        description: line.entry.description ?? '',
        debit: markUnverified(line.debit, currency, []),
        credit: markUnverified(line.credit, currency, []),
        running: { amount: running.toString(), currency, unverified: [] },
      },
    };
  });

  const cols: ReportColumn[] = [
    { key: 'date', label: 'Date', type: 'date' },
    { key: 'entry', label: 'Entry', type: 'text' },
    { key: 'account', label: 'Account', type: 'text' },
    { key: 'description', label: 'Description', type: 'text' },
    { key: 'debit', label: 'Debit', type: 'amount', currency },
    { key: 'credit', label: 'Credit', type: 'amount', currency },
    { key: 'running', label: 'Running balance', type: 'amount', currency },
  ];

  return {
    reportKey: 'general-ledger', title, category,
    generatedAt: new Date().toISOString(), currency, filters,
    sections: [{ key: 'gl', label: 'General ledger', columns: cols, rows }],
    checks: [], hasUnverified: false,
  };
}

export async function buildCashFlow(
  ctx: unknown,
  scope: Scope,
  filters: ReportFilters,
  title: string,
  category: ReportResult['category'],
): Promise<ReportResult> {
  const currency = filters.currency ?? scope.baseCurrency;
  const window = await resolveWindow(scope.organizationId, filters);

  const cashAccounts = await prisma.account.findMany({
    where: { organizationId: scope.organizationId, subCategory: { in: CASH_SUBCATEGORIES } },
    select: { id: true },
  });
  const cashIds = new Set(cashAccounts.map((a) => a.id));

  const lines = await prisma.journalLine.findMany({
    where: ledgerLineWhere(scope, window, filters),
    select: { accountId: true, debit: true, credit: true, account: { select: { type: true, subCategory: true } } },
  });

  // Indirect method: classify the NON-cash leg of each posting; its sign tells us
  // the cash movement it produced.
  let operating = dec(0);
  let investing = dec(0);
  let financing = dec(0);
  for (const line of lines) {
    if (cashIds.has(line.accountId)) continue;
    const cashEffect = dec(line.credit).minus(dec(line.debit)); // opposite of the non-cash leg
    if (line.account.type === 'REVENUE' || line.account.type === 'EXPENSE') operating = operating.plus(cashEffect);
    else if (line.account.type === 'ASSET') investing = investing.plus(cashEffect);
    else if (line.account.type === 'LIABILITY' || line.account.type === 'EQUITY') financing = financing.plus(cashEffect);
  }
  const netChange = operating.plus(investing).plus(financing);

  const line = (label: string, value: Decimal): ReportRow => ({
    id: label.toLowerCase().replace(/\s+/g, '-'),
    cells: { label, amount: markUnverified(value, currency, []) },
  });

  return {
    reportKey: 'cash-flow', title, category,
    generatedAt: new Date().toISOString(), currency, filters,
    sections: [{
      key: 'cash-flow', label: 'Cash flow (indirect)',
      columns: [{ key: 'label', label: 'Activity', type: 'text' }, { key: 'amount', label: 'Net cash', type: 'amount', currency }],
      rows: [
        line('Operating activities', operating),
        line('Investing activities', investing),
        line('Financing activities', financing),
        line('Net change in cash', netChange),
      ],
    }],
    checks: [], hasUnverified: false,
  };
}

type AgingBucket = 'CURRENT' | 'DAYS_1_30' | 'DAYS_31_60' | 'DAYS_61_90' | 'DAYS_91_PLUS';

function agingBucket(dueDate: Date, asOf: Date): { bucket: AgingBucket; daysPastDue: number } {
  const due = Date.UTC(dueDate.getUTCFullYear(), dueDate.getUTCMonth(), dueDate.getUTCDate());
  const today = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  const daysPastDue = Math.max(0, Math.floor((today - due) / 86_400_000));
  if (due >= today) return { bucket: 'CURRENT', daysPastDue: 0 };
  if (daysPastDue <= 30) return { bucket: 'DAYS_1_30', daysPastDue };
  if (daysPastDue <= 60) return { bucket: 'DAYS_31_60', daysPastDue };
  if (daysPastDue <= 90) return { bucket: 'DAYS_61_90', daysPastDue };
  return { bucket: 'DAYS_91_PLUS', daysPastDue };
}

async function buildAging(
  scope: Scope,
  filters: ReportFilters,
  title: string,
  category: ReportResult['category'],
  direction: 'RECEIVABLE' | 'PAYABLE',
  reportKey: string,
): Promise<ReportResult> {
  const currency = filters.currency ?? scope.baseCurrency;
  const asOf = filters.asAtDate ? new Date(filters.asAtDate) : new Date();

  const invoices = await prisma.invoice.findMany({
    where: {
      organizationId: scope.organizationId,
      direction,
      status: { in: ['SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE'] },
      invoiceDate: { lte: asOf },
      ...(filters.currency ? { currencyCode: filters.currency } : {}),
    },
    include: {
      customer: { include: { party: { select: { displayName: true } } } },
      supplier: { include: { party: { select: { displayName: true } } } },
      allocations: { select: { amount: true } },
    },
    orderBy: [{ dueDate: 'asc' }],
  });

  const bucketTotals = new Map<AgingBucket, Decimal>();
  const rows: ReportRow[] = [];
  for (const invoice of invoices) {
    const paid = invoice.allocations.reduce((s, a) => s.plus(dec(a.amount)), dec(0));
    const outstanding = dec(invoice.totalAmount).minus(paid);
    if (outstanding.lessThanOrEqualTo(0)) continue;
    const { bucket, daysPastDue } = agingBucket(invoice.dueDate, asOf);
    bucketTotals.set(bucket, (bucketTotals.get(bucket) ?? dec(0)).plus(outstanding));
    rows.push({
      id: invoice.id,
      cells: {
        number: invoice.number,
        party: invoice.customer?.party.displayName ?? invoice.supplier?.party.displayName ?? 'Unknown',
        dueDate: invoice.dueDate.toISOString().slice(0, 10),
        age: daysPastDue,
        bucket,
        outstanding: markUnverified(outstanding, invoice.currencyCode, []),
      },
    });
  }

  const controlCode = direction === 'RECEIVABLE' ? '1141' : '2111';
  const control = await prisma.account.findFirst({
    where: { organizationId: scope.organizationId, code: controlCode, isPostable: true },
    select: { id: true },
  });
  let controlBalance = dec(0);
  if (control) {
    const ledgerLines = await prisma.journalLine.findMany({
      where: { organizationId: scope.organizationId, accountId: control.id, entry: { status: { in: POSTED_STATUSES } } },
      select: { debit: true, credit: true },
    });
    const debits = ledgerLines.reduce((s, l) => s.plus(dec(l.debit)), dec(0));
    const credits = ledgerLines.reduce((s, l) => s.plus(dec(l.credit)), dec(0));
    controlBalance = direction === 'RECEIVABLE' ? debits.minus(credits) : credits.minus(debits);
  }
  const subledgerTotal = [...bucketTotals.values()].reduce((s, v) => s.plus(v), dec(0));

  const cols: ReportColumn[] = [
    { key: 'number', label: 'Invoice', type: 'text' },
    { key: 'party', label: direction === 'RECEIVABLE' ? 'Customer' : 'Supplier', type: 'text' },
    { key: 'dueDate', label: 'Due date', type: 'date' },
    { key: 'age', label: 'Days past due', type: 'text' },
    { key: 'bucket', label: 'Bucket', type: 'badge' },
    { key: 'outstanding', label: 'Outstanding', type: 'amount', currency },
  ];

  return {
    reportKey, title, category,
    generatedAt: new Date().toISOString(), currency, filters,
    sections: [{ key: 'aging', label: `${title} â€” by invoice`, columns: cols, rows }],
    checks: [{ key: 'subledger-vs-control', label: 'Subledger total equals control account balance', passed: subledgerTotal.equals(controlBalance), detail: `Subledger ${subledgerTotal.toString()} vs control ${controlBalance.toString()}` }],
    hasUnverified: false,
  };
}

export async function buildReceivablesAging(ctx: unknown, scope: Scope, filters: ReportFilters, title: string, category: ReportResult['category']) {
  return buildAging(scope, filters, title, category, 'RECEIVABLE', 'receivables-aging');
}

export async function buildPayablesAging(ctx: unknown, scope: Scope, filters: ReportFilters, title: string, category: ReportResult['category']) {
  return buildAging(scope, filters, title, category, 'PAYABLE', 'payables-aging');
}

export async function buildBankReconciliation(
  ctx: unknown,
  scope: Scope,
  filters: ReportFilters,
  title: string,
  category: ReportResult['category'],
): Promise<ReportResult> {
  const currency = filters.currency ?? scope.baseCurrency;
  const sessions = await prisma.reconciliationSession.findMany({
    where: { organizationId: scope.organizationId, ...(filters.periodId ? { periodId: filters.periodId } : {}) },
    include: { treasuryAccount: { select: { code: true, name: true } }, _count: { select: { exceptions: true, matches: true } } },
    orderBy: { statementEndDate: 'desc' },
  });

  const rows: ReportRow[] = sessions.map((s) => ({
    id: s.id,
    cells: {
      account: `${s.treasuryAccount.code} ${s.treasuryAccount.name}`,
      status: s.status,
      statementEnd: s.statementEndDate ? s.statementEndDate.toISOString().slice(0, 10) : '',
      difference: markUnverified(s.difference ?? 0, s.currency ?? currency, []),
      matched: s._count.matches,
      exceptions: s._count.exceptions,
    },
  }));

  const cols: ReportColumn[] = [
    { key: 'account', label: 'Treasury account', type: 'text' },
    { key: 'status', label: 'Status', type: 'badge' },
    { key: 'statementEnd', label: 'Statement end', type: 'date' },
    { key: 'difference', label: 'Difference', type: 'amount', currency },
    { key: 'matched', label: 'Matched', type: 'text' },
    { key: 'exceptions', label: 'Exceptions', type: 'text' },
  ];

  return {
    reportKey: 'bank-reconciliation', title, category,
    generatedAt: new Date().toISOString(), currency, filters,
    sections: [{ key: 'reconciliation', label: 'Reconciliation sessions', columns: cols, rows }],
    checks: [], hasUnverified: false,
  };
}

