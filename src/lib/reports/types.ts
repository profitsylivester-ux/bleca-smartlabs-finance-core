/**
 * Shared types for the M14 reporting & exports engine (PDF §47).
 *
 * Reports are COMPUTED server-side from JournalLine / Transaction / Budget /
 * OpeningBalance. There is no report table: a report is a deterministic query
 * over the ledger, so it can never drift from the GL and can always be rebuilt.
 *
 * The one rule every report obeys (PDF §2, risk R1 in PHASE_1_PLAN.md): a figure
 * derived from unverified or historical data MUST be visibly marked, so the CEO
 * cannot mistake the partial bootcamp position for a closed result. MarkedAmount
 * and the markUnverified helper in ./unverified.ts enforce that at the type level.
 */

import type { Prisma } from '@/generated/prisma/client';

/** The five report families from PDF §47. */
export type ReportCategory = 'FINANCIAL' | 'MANAGEMENT' | 'FUNDING' | 'COMPLIANCE' | 'EXECUTIVE';

/**
 * Whether a report can be produced now. Phase 1 must list reports whose backing
 * module is not built (e.g. an Asset register, since Assets is Phase 2) WITHOUT
 * faking data. The registry declares those AVAILABLE=false with a reason, and the
 * engine refuses to fabricate rows. "Declared but not built" is honest, not a 404.
 */
export type ReportAvailability = 'AVAILABLE' | 'UNAVAILABLE';

/** A single reason a figure is not fully verified. */
export interface UnverifiedReason {
  code:
    | 'OPENING_BALANCE_UNVERIFIED'
    | 'OPENING_BALANCE_PENDING'
    | 'OPENING_BALANCE_DISPUTED'
    | 'HISTORICAL_IMPORT';
  /** Human sentence for the UI/PDF legend. */
  message: string;
  /** Provenance: the OpeningBalance.source string, or import batch reference. */
  source: string;
  accountCode?: string;
}

/**
 * A money figure that carries its own verification provenance. `unverified` is
 * empty when every contributing posting is verified. Consumers render the marker
 * whenever it is non-empty; they never silently drop it.
 */
export interface MarkedAmount {
  /** Decimal string, base-currency unless `currency` says otherwise. */
  amount: string;
  currency: string;
  unverified: UnverifiedReason[];
  /** Original (transaction) currency amount when it differs from base. */
  originalAmount?: string;
  originalCurrency?: string;
  /** FX rate + date used, for the multi-currency test assertion. */
  fxRate?: string;
  fxRateDate?: string;
}

/** The filter set every report accepts (PDF §47 + M14 scope). */
export interface ReportFilters {
  periodId?: string;
  startDate?: string;
  endDate?: string;
  /** "as at" date for balance-sheet-style point-in-time reports. */
  asAtDate?: string;
  projectId?: string;
  departmentId?: string;
  costCentreId?: string;
  fundingSourceId?: string;
  locationId?: string;
  /** Reporting/base currency code (e.g. TZS). Defaults to the org base currency. */
  currency?: string;
  /** Prior period/date for comparative columns. */
  comparativePeriodId?: string;
  comparativeDate?: string;
  /** Executive report cadence. */
  cadence?: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
}

/** A column in a rendered report table. */
export interface ReportColumn {
  key: string;
  label: string;
  /** 'amount' columns get the unverified marker treatment; 'text' do not. */
  type: 'text' | 'amount' | 'date' | 'badge';
  currency?: string;
}

/** A single rendered row. Amount cells are MarkedAmount; others are primitives. */
export type ReportCell = MarkedAmount | string | number | boolean | null;

export interface ReportRow {
  id: string;
  cells: Record<string, ReportCell>;
}

/** A titled block of rows (e.g. "Assets", "Revenue by category"). */
export interface ReportSection {
  key: string;
  label: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  subtotal?: Record<string, MarkedAmount>;
}

/**
 * The uniform result of computing any report. Renderers (JSON, CSV, XLSX, PDF,
 * UI) all consume this one shape, so a new report only has to produce a
 * ReportResult and every export format works for free. `checks` carry the
 * tie-to-GL assertions the integration tests read.
 */
export interface ReportResult {
  reportKey: string;
  title: string;
  category: ReportCategory;
  generatedAt: string;
  currency: string;
  filters: ReportFilters;
  sections: ReportSection[];
  checks: ReportCheck[];
  /** True if ANY figure anywhere in the report is unverified. */
  hasUnverified: boolean;
  /** When the report is declared-unavailable, this explains why (no fake data). */
  unavailableReason?: string;
}

export interface ReportCheck {
  key: string;
  label: string;
  passed: boolean;
  /** e.g. "Debits 1,200.00 == Credits 1,200.00". */
  detail: string;
}

/** A report as declared in the registry. */
export interface ReportDefinition {
  key: string;
  title: string;
  description: string;
  category: ReportCategory;
  availability: ReportAvailability;
  unavailableReason?: string;
  /** Milestone that delivers an unavailable report, for the honest label. */
  deliveredByMilestone?: string;
  /** Which filters this report actually uses (drives the UI filter form). */
  supportedFilters: Array<keyof ReportFilters>;
}

/** Narrow Prisma Decimal to a plain decimal string without float rounding. */
export function toDecimalString(value: Prisma.Decimal | number | string | null | undefined): string {
  if (value === null || value === undefined) return '0';
  return value.toString();
}
