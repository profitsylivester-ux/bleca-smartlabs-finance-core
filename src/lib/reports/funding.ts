import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db/prisma';
import {
  dec,
  ledgerLineWhere,
  resolveWindow,
  type Scope,
} from './internal';
import type { ReportColumn, ReportFilters, ReportResult, ReportRow } from './types';

/** FUNDING report builders (PDF §47). */

/** Funding summary: received, spent and remaining per funding source. */
export async function buildFundingSummary(
  ctx: unknown,
  scope: Scope,
  filters: ReportFilters,
  title: string,
  category: ReportResult['category'],
): Promise<ReportResult> {
  const currency = filters.currency ?? scope.baseCurrency;
  const window = await resolveWindow(scope.organizationId, filters);

  const sources = await prisma.fundingSource.findMany({
    where: { organizationId: scope.organizationId, ...(filters.fundingSourceId ? { id: filters.fundingSourceId } : {}) },
    orderBy: { code: 'asc' },
  });

  const lines = await prisma.journalLine.findMany({
    where: ledgerLineWhere(scope, window, filters, ['REVENUE', 'EXPENSE']),
    select: { fundingSourceId: true, debit: true, credit: true, account: { select: { type: true } } },
  });

  const received = new Map<string, ReturnType<typeof dec>>();
  const spent = new Map<string, ReturnType<typeof dec>>();
  for (const line of lines) {
    const fsId = line.fundingSourceId ?? 'unassigned';
    if (line.account.type === 'REVENUE') received.set(fsId, (received.get(fsId) ?? dec(0)).plus(dec(line.credit).minus(dec(line.debit))));
    else spent.set(fsId, (spent.get(fsId) ?? dec(0)).plus(dec(line.debit).minus(dec(line.credit))));
  }

  const rows: ReportRow[] = sources.map((s) => {
    const rec = received.get(s.id) ?? dec(0);
    const exp = spent.get(s.id) ?? dec(0);
    return {
      id: s.id,
      cells: {
        source: `${s.code} ${s.name}`,
        type: s.type,
        restricted: s.isRestricted,
        received: { amount: rec.toString(), currency, unverified: [] },
        spent: { amount: exp.toString(), currency, unverified: [] },
        remaining: { amount: rec.minus(exp).toString(), currency, unverified: [] },
      },
    };
  });

  return {
    reportKey: 'funding-summary', title, category,
    generatedAt: new Date().toISOString(), currency, filters,
    sections: [{ key: 'funding', label: 'Funding received & utilization', columns: [
      { key: 'source', label: 'Funding source', type: 'text' },
      { key: 'type', label: 'Type', type: 'badge' },
      { key: 'restricted', label: 'Restricted', type: 'badge' },
      { key: 'received', label: 'Received', type: 'amount', currency },
      { key: 'spent', label: 'Spent', type: 'amount', currency },
      { key: 'remaining', label: 'Remaining', type: 'amount', currency },
    ], rows }],
    checks: [], hasUnverified: false,
  };
}

/** Eligible cost-category mapping, mirroring the restricted-funding guard. */
export function eligibleCostCategory(subCategory: string | null): string | null {
  switch (subCategory) {
    case 'EXPENSE_SALARIES': return 'PERSONNEL';
    case 'EXPENSE_HARDWARE_PROTOTYPING': return 'EQUIPMENT';
    case 'EXPENSE_TRANSPORT': return 'TRAVEL';
    default: return null;
  }
}

/**
 * Restricted funds & grant report. Utilisation counts ONLY eligible spend: an
 * expense is eligible for a restricted source when its project is in the
 * source's allowedProjects (if set) AND its cost category is in
 * allowedCostCategories (if set). Ineligible spend is excluded and listed
 * separately — the behaviour the restricted funding integration test asserts.
 */
export async function buildRestrictedFunds(
  ctx: unknown,
  scope: Scope,
  filters: ReportFilters,
  title: string,
  category: ReportResult['category'],
): Promise<ReportResult> {
  const currency = filters.currency ?? scope.baseCurrency;
  const window = await resolveWindow(scope.organizationId, filters);

  const sources = await prisma.fundingSource.findMany({
    where: { organizationId: scope.organizationId, isRestricted: true },
    orderBy: { code: 'asc' },
  });

  const expenseLines = await prisma.journalLine.findMany({
    where: ledgerLineWhere(scope, window, filters, ['EXPENSE']),
    select: { fundingSourceId: true, debit: true, credit: true, account: { select: { subCategory: true } }, project: { select: { code: true } } },
  });

  const readArray = (value: Prisma.JsonValue | null | undefined, key: string): string[] | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = (value as Record<string, unknown>)[key];
    if (!Array.isArray(raw)) return null;
    return raw.filter((v): v is string => typeof v === 'string');
  };

  const rows: ReportRow[] = [];
  for (const source of sources) {
    const allowedProjects = readArray(source.restrictions, 'allowedProjects');
    const allowedCategories = readArray(source.restrictions, 'allowedCostCategories');

    let eligible = dec(0);
    let ineligible = dec(0);
    for (const line of expenseLines) {
      if (line.fundingSourceId !== source.id) continue;
      const spend = dec(line.debit).minus(dec(line.credit));
      const projectOk = allowedProjects === null || (line.project ? allowedProjects.includes(line.project.code) : false);
      const costCat = eligibleCostCategory(line.account.subCategory);
      const categoryOk = allowedCategories === null || (costCat !== null && allowedCategories.includes(costCat));
      if (projectOk && categoryOk) eligible = eligible.plus(spend);
      else ineligible = ineligible.plus(spend);
    }

    rows.push({
      id: source.id,
      cells: {
        source: `${source.code} ${source.name}`,
        eligibleSpend: { amount: eligible.toString(), currency, unverified: [] },
        ineligibleSpend: { amount: ineligible.toString(), currency, unverified: [] },
      },
    });
  }

  return {
    reportKey: 'restricted-funds', title, category,
    generatedAt: new Date().toISOString(), currency, filters,
    sections: [{ key: 'restricted', label: 'Restricted funds utilisation', columns: [
      { key: 'source', label: 'Restricted source', type: 'text' },
      { key: 'eligibleSpend', label: 'Eligible spend', type: 'amount', currency },
      { key: 'ineligibleSpend', label: 'Ineligible spend (excluded)', type: 'amount', currency },
    ], rows }],
    checks: [], hasUnverified: false,
  };
}
