/**
 * Dashboard figure types (M16, PDF §48).
 *
 * Every figure is derived from the ledger via the reports engine — the same
 * computation the /reports pages show.
 */

export interface MoneyFigure {
  amount: string;
  currency: string;
}

export interface MarkedMoneyFigure extends MoneyFigure {
  unverified: boolean;
}

export interface CeoDashboardFigures {
  currency: string;
  generatedAt: string;
  cashPosition: MarkedMoneyFigure;
  revenuePeriodToDate: MarkedMoneyFigure;
  expensesPeriodToDate: MarkedMoneyFigure;
  netResult: MarkedMoneyFigure;
  receivablesOutstanding: MoneyFigure;
  payablesOutstanding: MoneyFigure;
  /** M16 treasury datum names, projected from the cash-position report. */
  cashDeposits: MoneyFigure;
  cashWithdrawals: MoneyFigure;
  pettyCashOpenBalance: MoneyFigure;
  budgetUtilisation: { approved: string; actual: string; overBudgetCount: number; currency: string };
  pendingApprovals: number;
  openAnomalies: number;
  hasUnverified: boolean;
}

export interface FinanceDashboardFigures {
  currency: string;
  generatedAt: string;
  cashPosition: MoneyFigure;
  transactionsByStatus: Array<{ status: string; count: number }>;
  pendingApprovals: number;
  unreconciledSessions: number;
  overdueInvoices: { receivables: number; payables: number };
  overBudgetCount: number;
  openAnomalies: number;
  recentAnomalies: Array<{ id: string; anomalyType: string; severity: string; status: string; description: string }>;
}
