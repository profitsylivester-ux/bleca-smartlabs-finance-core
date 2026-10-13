import { NotFoundError } from '@/lib/kernel/errors';
import { authorize } from '@/lib/kernel/authorize';
import type { RequestContext } from '@/lib/kernel/context';
import { loadScope, type Scope } from './internal';
import { reportDefinition } from './registry';
import type { ReportFilters, ReportResult } from './types';
import {
  buildIncomeStatement,
  buildBalanceSheet,
  buildTrialBalance,
} from './financial';
import {
  buildGeneralLedger,
  buildCashFlow,
  buildReceivablesAging,
  buildPayablesAging,
  buildBankReconciliation,
} from './ledger';
import {
  buildBudgetVsActual,
  buildProjectProfitability,
  buildRevenueAnalysis,
  buildExpenseAnalysis,
  buildCashPosition,
  buildRunwayBurn,
  buildFinancialKpis,
} from './management';
import { buildFundingSummary, buildRestrictedFunds } from './funding';
import { buildTaxReport, buildComplianceStatus, buildExpiringDocuments } from './compliance';
import { buildExecutive } from './executive';

/**
 * The report dispatcher (M14, PDF §47).
 *
 * `computeReport` authorizes (REPORTS, VIEW), resolves the org scope, refuses to
 * fabricate data for a declared-unavailable report, and otherwise delegates to
 * the matching builder. Every builder returns the same ReportResult shape, so
 * the export renderers and the UI need no per-report special-casing.
 *
 * Export permission is enforced separately by the export path (PDF §49: view
 * does not imply export).
 */
export async function computeReport(
  ctx: RequestContext,
  reportKey: string,
  filters: ReportFilters,
): Promise<ReportResult> {
  await authorize(ctx, { module: 'REPORTS', action: 'VIEW' });
  const definition = reportDefinition(reportKey);
  if (!definition) {
    throw new NotFoundError('Report', reportKey);
  }
  const scope = await loadScope(ctx);
  const builder = BUILDERS[reportKey];

  // A declared-unavailable report, or a declared-available one with no builder
  // yet, returns an honest empty result carrying a reason — never fake rows.
  if (definition.availability === 'UNAVAILABLE' || !builder) {
    return {
      reportKey,
      title: definition.title,
      category: definition.category,
      generatedAt: new Date().toISOString(),
      currency: filters.currency ?? scope.baseCurrency,
      filters,
      sections: [],
      checks: [],
      hasUnverified: false,
      unavailableReason: definition.unavailableReason ?? 'This report is declared but not yet implemented.',
    };
  }

  return builder(ctx, scope, filters, definition.title, definition.category);
}

type Builder = (
  ctx: RequestContext,
  scope: Scope,
  filters: ReportFilters,
  title: string,
  category: ReportResult['category'],
) => Promise<ReportResult>;

const BUILDERS: Record<string, Builder> = {
  'income-statement': buildIncomeStatement,
  'balance-sheet': buildBalanceSheet,
  'cash-flow': buildCashFlow,
  'general-ledger': buildGeneralLedger,
  'trial-balance': buildTrialBalance,
  'receivables-aging': buildReceivablesAging,
  'payables-aging': buildPayablesAging,
  'bank-reconciliation': buildBankReconciliation,
  'budget-vs-actual': buildBudgetVsActual,
  'project-profitability': buildProjectProfitability,
  'revenue-analysis': buildRevenueAnalysis,
  'expense-analysis': buildExpenseAnalysis,
  'cash-position': buildCashPosition,
  'runway-burn': buildRunwayBurn,
  'financial-kpis': buildFinancialKpis,
  'funding-summary': buildFundingSummary,
  'restricted-funds': buildRestrictedFunds,
  'tax-report': buildTaxReport,
  'compliance-status': buildComplianceStatus,
  'expiring-documents': buildExpiringDocuments,
  'executive-monthly': buildExecutive,
  'executive-quarterly': buildExecutive,
  'executive-annual': buildExecutive,
};
