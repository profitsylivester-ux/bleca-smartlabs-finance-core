import { Prisma } from '@/generated/prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '@/lib/db/prisma';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';
import type { RequestContext } from '@/lib/kernel/context';
import { markUnverified, type UnverifiedContribution } from './unverified';
import type { MarkedAmount, ReportFilters, ReportResult } from './types';

/**
 * Internal helpers shared by every report builder (M14, PDF §47).
 *
 * Reports are COMPUTED server-side from JournalLine / Transaction / Budget /
 * OpeningBalance. There is no report cache table: a figure is always derived
 * from the ledger, so it cannot drift from the GL and an auditor can always
 * re-derive it.
 */

export const dec = (v: Prisma.Decimal | number | string | null | undefined): Decimal =>
  v === null || v === undefined ? new Decimal(0) : v instanceof Decimal ? v : new Decimal(v);

/** Statuses that count as "in the books" for ledger reports. */
export const POSTED_STATUSES: Array<'POSTED' | 'LOCKED'> = ['POSTED', 'LOCKED'];

export interface Scope {
  organizationId: string;
  baseCurrency: string;
}

export async function loadScope(ctx: RequestContext): Promise<Scope> {
  if (!ctx.actor.organizationId) {
    throw new ValidationError('An organization context is required to run reports.');
  }
  const org = await prisma.organization.findUnique({
    where: { id: ctx.actor.organizationId },
    select: { baseCurrency: true },
  });
  if (!org) throw new NotFoundError('Organization', ctx.actor.organizationId);
  return { organizationId: ctx.actor.organizationId, baseCurrency: org.baseCurrency };
}

/**
 * Unverified opening-balance provenance, keyed by accountId (PDF §2).
 *
 * Opening balances are the bootcamp position: a one-sided, partially entered
 * historical figure. They are not auto-posted to JournalLine, so a ledger report
 * does not "see" them as postings — but any account carrying an unverified
 * opening balance is one whose reported figure is not fully trustworthy.
 */
export async function loadUnverifiedByAccount(
  organizationId: string,
): Promise<Map<string, UnverifiedContribution[]>> {
  const rows = await prisma.openingBalance.findMany({
    where: {
      organizationId,
      verificationStatus: { in: ['UNVERIFIED', 'PENDING_VERIFICATION', 'DISPUTED'] },
    },
    select: {
      accountId: true,
      verificationStatus: true,
      source: true,
      account: { select: { code: true } },
    },
  });
  const map = new Map<string, UnverifiedContribution[]>();
  for (const row of rows) {
    const list = map.get(row.accountId) ?? [];
    list.push({
      accountCode: row.account.code,
      verificationStatus: row.verificationStatus,
      source: row.source,
    });
    map.set(row.accountId, list);
  }
  return map;
}

export function contributionsFor(
  unverified: Map<string, UnverifiedContribution[]>,
  accountId: string,
): UnverifiedContribution[] {
  return unverified.get(accountId) ?? [];
}

/** Resolve a period's [start, end] window, or use explicit date filters. */
export async function resolveWindow(
  organizationId: string,
  filters: ReportFilters,
): Promise<{ startDate?: Date; endDate?: Date; periodId?: string }> {
  if (filters.periodId) {
    const period = await prisma.financialPeriod.findFirst({
      where: { id: filters.periodId, organizationId },
      select: { startDate: true, endDate: true },
    });
    if (period) {
      return { startDate: period.startDate, endDate: period.endDate, periodId: filters.periodId };
    }
  }
  return {
    startDate: filters.startDate ? new Date(filters.startDate) : undefined,
    endDate: filters.endDate ? new Date(filters.endDate) : undefined,
    periodId: undefined,
  };
}

/** The dimension filter fragment shared by every ledger-scoped query. */
export function dimensionWhere(filters: ReportFilters): Prisma.JournalLineWhereInput {
  return {
    ...(filters.projectId ? { projectId: filters.projectId } : {}),
    ...(filters.departmentId ? { departmentId: filters.departmentId } : {}),
    ...(filters.costCentreId ? { costCentreId: filters.costCentreId } : {}),
    ...(filters.fundingSourceId ? { fundingSourceId: filters.fundingSourceId } : {}),
    ...(filters.locationId ? { locationId: filters.locationId } : {}),
  };
}

/**
 * Build the posted-journal-line `where` for a period/date window plus dimensions.
 * A window is applied on the transaction date when present, else postedAt,
 * matching how the availability engine attributes spend.
 */
export function ledgerLineWhere(
  scope: Scope,
  window: { startDate?: Date; endDate?: Date; periodId?: string },
  filters: ReportFilters,
  accountType?: Array<'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE'>,
): Prisma.JournalLineWhereInput {
  const entryWhere: Prisma.JournalEntryWhereInput = {
    organizationId: scope.organizationId,
    status: { in: POSTED_STATUSES },
  };
  if (window.periodId) entryWhere.periodId = window.periodId;
  if (window.startDate || window.endDate) {
    entryWhere.OR = [
      { transaction: { is: { date: dateRange(window.startDate, window.endDate) } } },
      { transaction: { is: null }, postedAt: dateRange(window.startDate, window.endDate) },
    ];
  }
  return {
    organizationId: scope.organizationId,
    ...(accountType ? { account: { type: { in: accountType } } } : {}),
    ...(filters.currency ? { currencyCode: filters.currency } : {}),
    ...dimensionWhere(filters),
    entry: entryWhere,
  };
}

function dateRange(start?: Date, end?: Date): Prisma.DateTimeFilter {
  const filter: Prisma.DateTimeFilter = {};
  if (start) filter.gte = start;
  if (end) {
    const inclusive = new Date(end);
    inclusive.setUTCHours(23, 59, 59, 999);
    filter.lte = inclusive;
  }
  return filter;
}

export { markUnverified };
export type { MarkedAmount, ReportResult };

/** Sum a set of marked amounts, unioning their unverified provenance. */
export function sumMarked(values: MarkedAmount[], currency: string): MarkedAmount {
  const total = values.reduce((sum, v) => sum.plus(dec(v.amount)), new Decimal(0));
  const unverified = values.flatMap((v) => v.unverified);
  const seen = new Set<string>();
  const deduped = unverified.filter((r) => {
    const key = `${r.code}:${r.accountCode}:${r.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { amount: total.toString(), currency, unverified: deduped };
}
