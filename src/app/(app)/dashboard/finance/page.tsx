import type { Metadata } from 'next';
import React from 'react';
import { PageHeader } from '@/components/ui';
import { StatTile } from '@/components/planned';
import { requireContext, requirePageActor } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { prisma } from '@/lib/db/prisma';
import { formatDateTime, formatAmount, formatInteger } from '@/lib/format';
import { getFinanceDashboard } from '@/lib/dashboards/finance';

export const metadata: Metadata = { title: 'Finance dashboard' };

/**
 * Finance Officer dashboard (PDF 62).
 *
 * Answers "what is waiting for me", not "what is the company worth". The two
 * dashboards are genuinely different views for that reason.
 */
export default async function FinanceDashboardPage() {
  const actor = await requirePageActor();
  const ctx = await requireContext();
  await authorize(ctx, { module: 'DASHBOARD_FINANCE', action: 'VIEW' });

  const [dashboard, failedLogins, openSecurityEvents, unverifiedUsers] = await Promise.all([
    getFinanceDashboard(ctx),
    prisma.loginHistory.findMany({
      where: { outcome: { not: 'SUCCESS' } },
      orderBy: { occurredAt: 'desc' },
      take: 8,
      select: {
        emailAttempted: true,
        outcome: true,
        failureReason: true,
        ipAddress: true,
        occurredAt: true,
      },
    }),
    prisma.securityEvent.count({ where: { acknowledgedAt: null } }),
    prisma.user.count({ where: { isActive: true, deletedAt: null } }),
  ]);

  const workQueues = [
    {
      label: 'Transactions in draft',
      hint: 'Prepare and submit them for approval',
      href: '/accounting/journal-entries',
      count: dashboard.transactionsByStatus.find((t) => t.status === 'DRAFT')?.count ?? 0,
    },
    {
      label: 'Transactions submitted',
      hint: 'Awaiting CEO decision',
      href: '/approvals',
      count: dashboard.transactionsByStatus.find((t) => t.status === 'SUBMITTED')?.count ?? 0,
    },
    {
      label: 'Approvals pending',
      hint: 'Decisions waiting on you',
      href: '/approvals',
      count: dashboard.pendingApprovals,
    },
    {
      label: 'Overdue receivables',
      hint: 'Customer invoices past due',
      href: '/sales/invoices',
      count: dashboard.overdueInvoices.receivables,
    },
    {
      label: 'Overdue payables',
      hint: 'Supplier invoices past due',
      href: '/sales/invoices',
      count: dashboard.overdueInvoices.payables,
    },
    {
      label: 'Unreconciled sessions',
      hint: 'Bank and mobile money to match',
      href: '/treasury/accounts',
      count: dashboard.unreconciledSessions,
    },
    {
      label: 'Open anomalies',
      hint: 'Flagged items needing review',
      href: '/admin/anomalies',
      count: dashboard.openAnomalies,
    },
    {
      label: 'Budget items to review',
      hint: 'Draft budgets and commitments',
      href: '/budgets',
      count: dashboard.overBudgetCount,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Finance dashboard"
        description={`Signed in as ${actor.fullName}. Work waiting on you appears here first.`}
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Cash position"
          value={formatAmount(dashboard.cashPosition.amount, dashboard.currency)}
          hint="M7"
        />
        <StatTile
          label="Pending approvals"
          value={formatInteger(dashboard.pendingApprovals)}
          hint={dashboard.pendingApprovals > 0 ? 'Action required' : 'All clear'}
        />
        <StatTile
          label="Unreconciled sessions"
          value={formatInteger(dashboard.unreconciledSessions)}
          hint={dashboard.unreconciledSessions > 0 ? 'Needs attention' : 'All clear'}
        />
        <StatTile
          label="Overdue invoices"
          value={formatInteger(dashboard.overdueInvoices.receivables + dashboard.overdueInvoices.payables)}
          hint={`AR: ${dashboard.overdueInvoices.receivables} · AP: ${dashboard.overdueInvoices.payables}`}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="border-border-subtle rounded-lg border bg-white p-4 space-y-3">
          <h2 className="text-sm font-semibold">Transaction status breakdown</h2>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            {dashboard.transactionsByStatus.map((t) => (
              <React.Fragment key={t.status}>
                <dt className="text-muted-foreground">{t.status}</dt>
                <dd className="tabular text-foreground font-medium">{formatInteger(t.count)}</dd>
              </React.Fragment>
            ))}
          </dl>
        </div>

        <div className="border-border-subtle rounded-lg border bg-white p-4 space-y-3">
          <h2 className="text-sm font-semibold">Budget & anomaly alerts</h2>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-muted-foreground">Over-budget count</dt>
            <dd className="tabular text-foreground font-medium">{formatInteger(dashboard.overBudgetCount)}</dd>
            <dt className="text-muted-foreground">Open anomalies</dt>
            <dd className="tabular text-foreground font-medium">{formatInteger(dashboard.openAnomalies)}</dd>
          </dl>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="border-border-subtle rounded-lg border bg-white p-4">
          <h2 className="text-sm font-semibold mb-3">Recent anomalies</h2>
          {dashboard.recentAnomalies.length === 0 ? (
            <p className="text-muted-foreground text-sm">No anomalies recorded.</p>
          ) : (
            <ul className="divide-border-subtle divide-y">
              {dashboard.recentAnomalies.map((a) => (
                <li key={a.id} className="py-2 flex flex-wrap items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium truncate">{a.anomalyType}</span>
                      <span className="text-muted-foreground mono text-xs">{a.id.slice(0, 8)}</span>
                      <span
                        className={`badge-xs ${
                          a.severity === 'CRITICAL'
                            ? 'bg-negative/10 text-negative'
                            : a.severity === 'HIGH'
                            ? 'bg-warning/10 text-warning'
                            : a.severity === 'MEDIUM'
                            ? 'bg-navy-300/10 text-navy-600'
                            : 'bg-muted-foreground/10 text-muted-foreground'
                        }`}
                      >
                        {a.severity}
                      </span>
                      <span
                        className={`badge-xs ${
                          a.status === 'OPEN'
                            ? 'bg-warning/10 text-warning'
                            : a.status === 'ACKNOWLEDGED'
                            ? 'bg-navy-300/10 text-navy-600'
                            : a.status === 'CONFIRMED'
                            ? 'bg-negative/10 text-negative'
                            : 'bg-success/10 text-success'
                        }`}
                      >
                        {a.status}
                      </span>
                    </div>
                    <p className="text-muted-foreground text-xs mt-1 truncate max-w-xs">{a.description}</p>
                  </div>
                  <a
                    href={`/admin/anomalies/${a.id}`}
                    className="text-navy-600 hover:text-navy-800 underline underline-offset-2 text-xs shrink-0"
                  >
                    View
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-border-subtle rounded-lg border bg-white">
          <div className="border-border-subtle border-b px-5 py-4">
            <h2 className="text-sm font-semibold">Recent failed sign-ins</h2>
            <p className="text-muted-foreground mt-0.5 text-xs">
              Worth a look: repeated failures against one address are the visible face of a
              credential attack.
            </p>
          </div>
          {failedLogins.length === 0 ? (
            <p className="text-muted-foreground px-5 py-6 text-sm">No failed sign-ins recorded.</p>
          ) : (
            <ul className="divide-border-subtle divide-y">
              {failedLogins.map((entry, i) => (
                <li key={i} className="px-5 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-sm">{entry.emailAttempted}</span>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {formatDateTime(entry.occurredAt)}
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    {entry.outcome}
                    {entry.failureReason ? ` - ${entry.failureReason}` : ''}
                    {entry.ipAddress ? ` - from ${entry.ipAddress}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="border-border-subtle rounded-lg border bg-white">
        <div className="border-border-subtle border-b px-5 py-4">
          <h2 className="text-sm font-semibold">Your work queues</h2>
          <p className="text-muted-foreground mt-0.5 text-xs">
            Work assigned to you and awaiting action. Click an item to open its register.
          </p>
        </div>
        <div className="divide-border-subtle divide-y">
          {workQueues.map((q) => (
            <a
              key={q.label}
              href={q.href}
              className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-muted/30"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{q.label}</p>
                <p className="text-muted-foreground text-xs">{q.hint}</p>
              </div>
              <span
                className={`tabular text-sm font-semibold shrink-0 ${q.count > 0 ? 'text-navy-700' : 'text-muted-foreground'}`}
              >
                {formatInteger(q.count)}
              </span>
            </a>
          ))}
        </div>
      </div>

      <p className="text-muted-foreground text-xs">
        {formatInteger(unverifiedUsers)} active account(s) in this organisation
        {openSecurityEvents > 0 ? `, ${formatInteger(openSecurityEvents)} unacknowledged security event(s)` : ''}.
      </p>
    </div>
  );
}