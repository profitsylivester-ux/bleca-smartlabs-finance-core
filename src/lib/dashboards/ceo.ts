import { prisma } from '@/lib/db/prisma';
import { Decimal } from '@prisma/client/runtime/library';
import type { RequestContext } from '@/lib/kernel/context';
import { authorize } from '@/lib/kernel/authorize';
import { loadScope } from '@/lib/reports/internal';
import { computeReport } from '@/lib/reports/engine';
import type { ReportResult } from '@/lib/reports/types';
import type { CeoDashboardFigures } from './types';

/** Dashboard figures (M16, PDF §48). Every figure comes from computeReport. */

export function cellAmount(r: ReportResult, sectionKey: string, rowId: string): string {
  const row = r.sections.find((s) => s.key === sectionKey)?.rows.find((x) => x.id === rowId);
  const cell = row?.cells.value;
  if (cell !== null && cell !== undefined && typeof cell === 'object' && 'amount' in cell) {
    return String((cell as { amount: unknown }).amount);
  }
  return '0';
}

export function sumCells(r: ReportResult, keys: string[]): string {
  let total = new Decimal(0);
  for (const section of r.sections) {
    for (const row of section.rows) {
      for (const key of keys) {
        const cell = row.cells[key];
        if (cell !== null && cell !== undefined && typeof cell === 'object' && 'amount' in cell) {
          total = total.plus(new Decimal(String((cell as { amount: unknown }).amount)));
        }
      }
    }
  }
  return total.toString();
}

export async function countMyPending(orgId: string, userId: string): Promise<number> {
  return prisma.approvalRequest.count({
    where: {
      organizationId: orgId,
      status: { in: ['PENDING', 'IN_PROGRESS'] },
      stepInstances: {
        some: {
          status: 'PENDING',
          OR: [
            { assigneeUserId: userId },
            { assigneeRole: { userRoles: { some: { userId, revokedAt: null } } } },
          ],
        },
      },
    },
  });
}

export async function getCeoDashboard(ctx: RequestContext): Promise<CeoDashboardFigures> {
  await authorize(ctx, { module: 'DASHBOARD_CEO', action: 'VIEW' });
  const scope = await loadScope(ctx);
  if (!ctx.actor.organizationId) throw new Error('No organization context');
  const orgId = ctx.actor.organizationId;
  const [cash, exec, rec, pay, budgets, pending, openAnom] = await Promise.all([
    computeReport(ctx, 'cash-position', {}),
    computeReport(ctx, 'executive-monthly', {}),
    computeReport(ctx, 'receivables-aging', {}),
    computeReport(ctx, 'payables-aging', {}),
    computeReport(ctx, 'budget-vs-actual', {}),
    countMyPending(orgId, ctx.actor.userId),
    prisma.anomalyFlag.count({ where: { organizationId: orgId, status: { in: ['OPEN', 'ACKNOWLEDGED'] } } }),
  ]);
  const currency = scope.baseCurrency;
  const revenue = cellAmount(exec, 'performance', 'total-revenue');
  const expenses = cellAmount(exec, 'performance', 'total-expenses');
  const cashOnHand = cellAmount(cash, 'position', 'cash-on-hand');
  let approved = new Decimal(0);
  let actual = new Decimal(0);
  let over = 0;
  const bs = budgets.sections.find((s) => s.key === 'budgets');
  if (bs) {
    for (const row of bs.rows) {
      const a = row.cells.approved;
      const b = row.cells.actual;
      if (a !== null && a !== undefined && typeof a === 'object' && 'amount' in a) {
        approved = approved.plus(new Decimal(String((a as { amount: unknown }).amount)));
      }
      if (b !== null && b !== undefined && typeof b === 'object' && 'amount' in b) {
        actual = actual.plus(new Decimal(String((b as { amount: unknown }).amount)));
      }
      if (row.cells.overBudget === true) over += 1;
    }
  }
  return {
    currency,
    generatedAt: new Date().toISOString(),
    cashPosition: { amount: cashOnHand, currency, unverified: cash.hasUnverified },
    revenuePeriodToDate: { amount: revenue, currency, unverified: exec.hasUnverified },
    expensesPeriodToDate: { amount: expenses, currency, unverified: exec.hasUnverified },
    netResult: { amount: new Decimal(revenue).minus(new Decimal(expenses)).toString(), currency, unverified: exec.hasUnverified },
    receivablesOutstanding: { amount: sumCells(rec, ['balance', 'value']), currency },
    payablesOutstanding: { amount: sumCells(pay, ['balance', 'value']), currency },
    cashDeposits: { amount: cellAmount(cash, 'position', 'total-receipts'), currency },
    cashWithdrawals: { amount: cellAmount(cash, 'position', 'total-payments'), currency },
    pettyCashOpenBalance: { amount: cashOnHand, currency },
    budgetUtilisation: { approved: approved.toString(), actual: actual.toString(), overBudgetCount: over, currency },
    pendingApprovals: pending,
    openAnomalies: openAnom,
    hasUnverified: cash.hasUnverified || exec.hasUnverified,
  };
}
