import type { ReportCategory, ReportDefinition } from './types';

/**
 * The report registry (PDF §47).
 *
 * One source of truth for what reports exist, which family each belongs to, and
 * — critically — which are DECLARED BUT UNAVAILABLE because their backing module
 * is a later milestone. The registry never claims a report is ready when it is
 * not: an unavailable report carries a plain-language reason and the milestone
 * that will deliver it, and the engine refuses to fabricate rows for it (PDF
 * §70–72 vs §47: Phase 1 must surface reports like "Asset register" whose module
 * is Phase 2, without faking the data).
 *
 * `GET /api/v1/reports` returns this list; `/reports` renders it by category.
 */

const PERIOD_FILTERS = ['periodId', 'startDate', 'endDate'] as const;
const DIMENSION_FILTERS = [
  'projectId',
  'departmentId',
  'costCentreId',
  'fundingSourceId',
  'locationId',
] as const;
const CURRENCY_FILTER = ['currency'] as const;

function report(def: ReportDefinition): ReportDefinition {
  return def;
}

export const REPORTS: ReportDefinition[] = [
  // ---- FINANCIAL (PDF §47) -------------------------------------------------
  report({
    key: 'income-statement',
    title: 'Income statement (P&L)',
    description: 'Revenue and expenses by category for a period, with a comparative prior period.',
    category: 'FINANCIAL',
    availability: 'AVAILABLE',
    supportedFilters: [...PERIOD_FILTERS, ...DIMENSION_FILTERS, ...CURRENCY_FILTER, 'comparativePeriodId'],
  }),
  report({
    key: 'balance-sheet',
    title: 'Balance sheet',
    description: 'Assets, liabilities and equity as at a date; asserts assets = liabilities + equity.',
    category: 'FINANCIAL',
    availability: 'AVAILABLE',
    supportedFilters: ['asAtDate', ...DIMENSION_FILTERS, ...CURRENCY_FILTER, 'comparativeDate'],
  }),
  report({
    key: 'cash-flow',
    title: 'Cash flow statement',
    description: 'Cash movements across operating, investing and financing activity for a period.',
    category: 'FINANCIAL',
    availability: 'AVAILABLE',
    supportedFilters: [...PERIOD_FILTERS, ...CURRENCY_FILTER],
  }),
  report({
    key: 'general-ledger',
    title: 'General Ledger by account',
    description: 'Every posted line with a running balance, per account.',
    category: 'FINANCIAL',
    availability: 'AVAILABLE',
    supportedFilters: [...PERIOD_FILTERS, ...DIMENSION_FILTERS, ...CURRENCY_FILTER],
  }),
  report({
    key: 'trial-balance',
    title: 'Trial balance',
    description: 'Debit and credit totals per account; asserts total debits equal total credits.',
    category: 'FINANCIAL',
    availability: 'AVAILABLE',
    supportedFilters: [...PERIOD_FILTERS, 'asAtDate', ...CURRENCY_FILTER],
  }),
  report({
    key: 'receivables-aging',
    title: 'Accounts receivable aging',
    description: 'Open customer invoice balances by overdue bucket, reconciled to the control account.',
    category: 'FINANCIAL',
    availability: 'AVAILABLE',
    supportedFilters: ['asAtDate', ...CURRENCY_FILTER],
  }),
  report({
    key: 'payables-aging',
    title: 'Accounts payable aging',
    description: 'Open supplier invoice balances by overdue bucket, reconciled to the control account.',
    category: 'FINANCIAL',
    availability: 'AVAILABLE',
    supportedFilters: ['asAtDate', ...CURRENCY_FILTER],
  }),
  report({
    key: 'bank-reconciliation',
    title: 'Bank reconciliation report',
    description: 'Reconciliation sessions and outstanding exceptions per treasury account.',
    category: 'FINANCIAL',
    availability: 'AVAILABLE',
    supportedFilters: [...PERIOD_FILTERS],
  }),

  // ---- MANAGEMENT (PDF §47) ------------------------------------------------
  report({
    key: 'budget-vs-actual',
    title: 'Budget vs Actual',
    description: 'Approved, committed, actual and available per budget, computed from the availability engine.',
    category: 'MANAGEMENT',
    availability: 'AVAILABLE',
    supportedFilters: [...DIMENSION_FILTERS, ...CURRENCY_FILTER],
  }),
  report({
    key: 'project-profitability',
    title: 'Project profitability',
    description: 'Revenue, expense and net result per project via the project dimension.',
    category: 'MANAGEMENT',
    availability: 'AVAILABLE',
    supportedFilters: [...PERIOD_FILTERS, ...CURRENCY_FILTER],
  }),
  report({
    key: 'revenue-analysis',
    title: 'Revenue analysis',
    description: 'Revenue by category, customer and period.',
    category: 'MANAGEMENT',
    availability: 'AVAILABLE',
    supportedFilters: [...PERIOD_FILTERS, ...DIMENSION_FILTERS, ...CURRENCY_FILTER],
  }),
  report({
    key: 'expense-analysis',
    title: 'Expense analysis',
    description: 'Expenses by category and cost centre.',
    category: 'MANAGEMENT',
    availability: 'AVAILABLE',
    supportedFilters: [...PERIOD_FILTERS, ...DIMENSION_FILTERS, ...CURRENCY_FILTER],
  }),
  report({
    key: 'cash-position',
    title: 'Cash position',
    description: 'Balances across every treasury account by kind and currency.',
    category: 'MANAGEMENT',
    availability: 'AVAILABLE',
    supportedFilters: ['asAtDate', ...CURRENCY_FILTER],
  }),
  report({
    key: 'runway-burn',
    title: 'Runway & burn rate',
    description: 'Average monthly net burn and months of runway at current cash.',
    category: 'MANAGEMENT',
    availability: 'AVAILABLE',
    supportedFilters: [...PERIOD_FILTERS, ...CURRENCY_FILTER],
  }),
  report({
    key: 'financial-kpis',
    title: 'Financial KPIs',
    description: 'Current ratio, net margin, expense ratio and cash coverage from the ledger.',
    category: 'MANAGEMENT',
    availability: 'AVAILABLE',
    supportedFilters: [...PERIOD_FILTERS, 'asAtDate', ...CURRENCY_FILTER],
  }),

  // ---- FUNDING (PDF §47) ---------------------------------------------------
  report({
    key: 'funding-summary',
    title: 'Funding received & utilization',
    description: 'Funding sources with received, spent and remaining balances, restricted vs unrestricted.',
    category: 'FUNDING',
    availability: 'AVAILABLE',
    supportedFilters: [...PERIOD_FILTERS, ...DIMENSION_FILTERS, ...CURRENCY_FILTER],
  }),
  report({
    key: 'restricted-funds',
    title: 'Restricted funds & grant report',
    description: 'Restricted funding sources with eligible-spend utilisation, excluding ineligible spend.',
    category: 'FUNDING',
    availability: 'AVAILABLE',
    supportedFilters: [...PERIOD_FILTERS, ...CURRENCY_FILTER],
  }),

  // ---- COMPLIANCE (PDF §47) ------------------------------------------------
  report({
    key: 'tax-report',
    title: 'Tax report',
    description: 'Tax obligations, taxable amounts and payments by period from configured rules.',
    category: 'COMPLIANCE',
    availability: 'AVAILABLE',
    supportedFilters: [...PERIOD_FILTERS],
  }),
  report({
    key: 'compliance-status',
    title: 'Compliance status',
    description: 'Registration status, unverified tax rules, due obligations and expiring credentials.',
    category: 'COMPLIANCE',
    availability: 'AVAILABLE',
    supportedFilters: [],
  }),
  report({
    key: 'expiring-documents',
    title: 'Expiring documents',
    description: 'Documents and credentials expiring within the next 90 days.',
    category: 'COMPLIANCE',
    availability: 'AVAILABLE',
    supportedFilters: [],
  }),

  // ---- EXECUTIVE (PDF §47) -------------------------------------------------
  report({
    key: 'executive-monthly',
    title: 'Monthly CEO report',
    description: 'One-page monthly summary: cash, revenue, expenses, result, budget utilisation, risks.',
    category: 'EXECUTIVE',
    availability: 'AVAILABLE',
    supportedFilters: [...PERIOD_FILTERS, ...CURRENCY_FILTER],
  }),
  report({
    key: 'executive-quarterly',
    title: 'Quarterly management report',
    description: 'Quarterly management pack: P&L, cash, budgets, funding and compliance highlights.',
    category: 'EXECUTIVE',
    availability: 'AVAILABLE',
    supportedFilters: [...PERIOD_FILTERS, ...CURRENCY_FILTER],
  }),
  report({
    key: 'executive-annual',
    title: 'Annual report',
    description: 'Annual financial overview for the fiscal year with year-on-year context.',
    category: 'EXECUTIVE',
    availability: 'AVAILABLE',
    supportedFilters: [...PERIOD_FILTERS, ...CURRENCY_FILTER],
  }),

  // ---- DECLARED BUT UNAVAILABLE (no fake data, PDF §47 + §70) --------------
  report({
    key: 'asset-register',
    title: 'Asset register',
    description: 'Fixed assets, depreciation and net book value.',
    category: 'FINANCIAL',
    availability: 'UNAVAILABLE',
    unavailableReason:
      'The Assets module is a later milestone. There is no asset data to report yet, so this report is declared rather than faked.',
    deliveredByMilestone: 'Phase 2',
    supportedFilters: [],
  }),
  report({
    key: 'inventory-valuation',
    title: 'Inventory valuation',
    description: 'Stock on hand, cost and valuation.',
    category: 'MANAGEMENT',
    availability: 'UNAVAILABLE',
    unavailableReason:
      'The Inventory module is a later milestone. Chart-of-accounts lines are reserved, but there is no stock movement data to report yet.',
    deliveredByMilestone: 'Phase 2',
    supportedFilters: [],
  }),
  report({
    key: 'forecast-projection',
    title: 'Forecast & projection',
    description: 'Forward cash and P&L projection.',
    category: 'EXECUTIVE',
    availability: 'UNAVAILABLE',
    unavailableReason:
      'Full forecasting is a later milestone. Phase 1 provides scenario factors on individual budgets, not an organisation-wide projection, so this report is declared rather than faked.',
    deliveredByMilestone: 'Phase 2',
    supportedFilters: [],
  }),
];

export const REPORT_BY_KEY = new Map(REPORTS.map((r) => [r.key, r]));

export const REPORT_CATEGORIES: Array<{ key: ReportCategory; label: string }> = [
  { key: 'FINANCIAL', label: 'Financial' },
  { key: 'MANAGEMENT', label: 'Management' },
  { key: 'FUNDING', label: 'Funding' },
  { key: 'COMPLIANCE', label: 'Compliance' },
  { key: 'EXECUTIVE', label: 'Executive' },
];

export function reportDefinition(key: string): ReportDefinition | undefined {
  return REPORT_BY_KEY.get(key);
}

export function reportsByCategory(category: ReportCategory): ReportDefinition[] {
  return REPORTS.filter((r) => r.category === category);
}
