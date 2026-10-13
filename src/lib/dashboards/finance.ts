import { prisma } from '@/lib/db/prisma';
import type { RequestContext } from '@/lib/kernel/context';
import { authorize } from '@/lib/kernel/authorize';
import { loadScope } from '@/lib/reports/internal';
import { computeReport } from '@/lib/reports/engine';
import type { FinanceDashboardFigures } from './types';
import { cellAmount } from './ceo';

/** Finance dashboard (M16, PDF §62): what is waiting, not what the company is worth. */

export async function getFinanceDashboard(ctx: RequestContext): Promise<FinanceDashboardFigures> {
  await authorize(ctx, { module: 'DASHBOARD_FINANCE', action: 'VIEW' });
  const scope = await loadScope(ctx);
  if (!ctx.actor.organizationId) throw new Error('No organization context');
  const orgId = ctx.actor.organizationId;
  const [cash, groups, pending, sessions, overdueRec, overduePay, over, openAnom, recent] = await Promise.all([
    computeReport(ctx, 'cash-position', {}),
    prisma.transaction.groupBy({ by: ['status'], where: { organizationId: orgId }, _count: { status: true } }),
    prisma.approvalRequest.count({ where: { organizationId: orgId, status: { in: ['PENDING', 'IN_PROGRESS'] } } }),
    prisma.reconciliationSession.count({ where: { organizationId: orgId, status: { in: ['NOT_STARTED', 'IN_PROGRESS'] } } }),
    prisma.customerReceivable.count({
      where: { organizationId: orgId, status: { in: ['OPEN', 'PARTIALLY_PAID'] }, dueAt: { lt: new Date() } },
    }),
    prisma.invoice.count({
      where: { organizationId: orgId, direction: 'PAYABLE', status: { in: ['SENT', 'PARTIALLY_PAID', 'OVERDUE'] }, dueDate: { lt: new Date() } },
    }),
    prisma.budget.count({ where: { organizationId: orgId, isOverBudget: true } }),
    prisma.anomalyFlag.count({ where: { organizationId: orgId, status: { in: ['OPEN', 'ACKNOWLEDGED'] } } }),
    prisma.anomalyFlag.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, anomalyType: true, severity: true, status: true, description: true },
    }),
  ]);
  return {
    currency: scope.baseCurrency,
    generatedAt: new Date().toISOString(),
    cashPosition: { amount: cellAmount(cash, 'position', 'cash-on-hand'), currency: scope.baseCurrency },
    transactionsByStatus: groups.map((g) => ({ status: g.status, count: g._count.status })),
    pendingApprovals: pending,
    unreconciledSessions: sessions,
    overdueInvoices: { receivables: overdueRec, payables: overduePay },
    overBudgetCount: over,
    openAnomalies: openAnom,
    recentAnomalies: recent.map((a) => ({
      id: a.id,
      anomalyType: a.anomalyType,
      severity: a.severity,
      status: a.status,
      description: a.description,
    })),
  };
}
