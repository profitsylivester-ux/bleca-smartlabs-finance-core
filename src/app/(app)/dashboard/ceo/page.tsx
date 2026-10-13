import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { PlannedPanel, StatTile } from '@/components/planned';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { prisma } from '@/lib/db/prisma';
import { verifyChain } from '@/lib/audit/verifier';
import { formatInteger, formatDateTime, formatRelative, formatAmount } from '@/lib/format';
import { Badge } from '@/components/ui';
import { Prisma } from '@/generated/prisma/client';
import { getCeoDashboard } from '@/lib/dashboards/ceo';

export const metadata: Metadata = { title: 'CEO dashboard' };

/**
 * CEO dashboard (PDF 61).
 *
 * Figures are derived from the ledger via the reports engine.
 */
const sodWaiverInclude = {
  user: { select: { fullName: true, emailNormalized: true } },
  recordedBy: { select: { fullName: true } },
  reviewedBy: { select: { fullName: true } },
  approvalRequest: { select: { id: true, entityType: true, entityId: true } },
} satisfies Prisma.SODWaiverInclude;

type SODWaiverWithRelations = Prisma.SODWaiverGetPayload<{ include: typeof sodWaiverInclude }>;

export default async function CeoDashboardPage() {
  const ctx = await requireContext();
  await authorize(ctx, { module: 'DASHBOARD_CEO', action: 'VIEW' });
  const orgId = ctx.actor.organizationId!;

  const [dashboard, chain, recentSignIns, pendingSecurityEvents, org, sodWaivers, pendingApprovals] = await Promise.all([
    getCeoDashboard(ctx),
    verifyChain({}),
    prisma.loginHistory.findMany({
      where: { outcome: 'SUCCESS' },
      orderBy: { occurredAt: 'desc' },
      take: 5,
      select: { emailAttempted: true, ipAddress: true, occurredAt: true },
    }),
    prisma.securityEvent.count({
      where: { acknowledgedAt: null, severity: { in: ['MEDIUM', 'HIGH', 'CRITICAL'] } },
    }),
    prisma.organization.findFirst({
      where: { isActive: true },
      select: { name: true, registrationStatus: true, baseCurrency: true },
    }),
    prisma.sODWaiver.findMany({
      where: { approvalRequest: { organizationId: orgId } },
      orderBy: { recordedAt: 'desc' },
      take: 10,
      include: sodWaiverInclude,
    }) as Promise<SODWaiverWithRelations[]>,
    prisma.approvalRequest.count({
      where: {
        organizationId: orgId,
        status: 'IN_PROGRESS',
        stepInstances: {
          some: {
            status: 'PENDING',
            OR: [
              { assigneeUserId: ctx.actor.userId },
              {
                assigneeRole: {
                  userRoles: {
                    some: { userId: ctx.actor.userId, revokedAt: null },
                  },
                },
              },
            ],
          },
        },
      },
    }),
  ]);

  const pendingSodWaivers = sodWaivers.filter((w) => w.status === 'PENDING');
  const grantedSodWaivers = sodWaivers.filter((w) => w.status === 'GRANTED');

  return (
    <div className="space-y-6">
      <PageHeader
        title="CEO dashboard"
        description={`${org?.name ?? 'BLECA SmartLabs'} - executive position, approvals and risk.`}
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Cash and bank position"
          value={formatAmount(dashboard.cashPosition.amount, dashboard.currency)}
          hint={dashboard.cashPosition.unverified ? 'Unverified data' : 'M7'}
        />
        <StatTile
          label="Revenue, period to date"
          value={formatAmount(dashboard.revenuePeriodToDate.amount, dashboard.currency)}
          hint={dashboard.revenuePeriodToDate.unverified ? 'Unverified data' : 'M4'}
        />
        <StatTile
          label="Outstanding receivables"
          value={formatAmount(dashboard.receivablesOutstanding.amount, dashboard.currency)}
          hint="M11"
        />
        <StatTile
          label="Budget utilisation"
          value={`${((Number(dashboard.budgetUtilisation.actual) / (Number(dashboard.budgetUtilisation.approved) || 1)) * 100).toFixed(1)}%`}
          hint={`${dashboard.budgetUtilisation.overBudgetCount} over budget`}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="border-border-subtle rounded-lg border bg-white p-4 space-y-3">
          <h2 className="text-sm font-semibold">Financial position</h2>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-muted-foreground">Expenses (period)</dt>
            <dd className="tabular text-foreground font-medium">{formatAmount(dashboard.expensesPeriodToDate.amount, dashboard.currency)}</dd>
            <dt className="text-muted-foreground">Net result</dt>
            <dd className="tabular text-foreground font-medium">{formatAmount(dashboard.netResult.amount, dashboard.currency)}</dd>
            <dt className="text-muted-foreground">Payables outstanding</dt>
            <dd className="tabular text-foreground font-medium">{formatAmount(dashboard.payablesOutstanding.amount, dashboard.currency)}</dd>
            <dt className="text-muted-foreground">Cash deposits</dt>
            <dd className="tabular text-foreground font-medium">{formatAmount(dashboard.cashDeposits.amount, dashboard.currency)}</dd>
            <dt className="text-muted-foreground">Cash withdrawals</dt>
            <dd className="tabular text-foreground font-medium">{formatAmount(dashboard.cashWithdrawals.amount, dashboard.currency)}</dd>
            <dt className="text-muted-foreground">Petty cash open balance</dt>
            <dd className="tabular text-foreground font-medium">{formatAmount(dashboard.pettyCashOpenBalance.amount, dashboard.currency)}</dd>
            <dt className="text-muted-foreground">Budget approved</dt>
            <dd className="tabular text-foreground font-medium">{formatAmount(dashboard.budgetUtilisation.approved, dashboard.currency)}</dd>
            <dt className="text-muted-foreground">Budget actual</dt>
            <dd className="tabular text-foreground font-medium">{formatAmount(dashboard.budgetUtilisation.actual, dashboard.currency)}</dd>
          </dl>
          {dashboard.hasUnverified && (
            <p className="text-warning text-xs mt-2">Some figures contain unverified (pre-closing) data.</p>
          )}
        </div>

        <div className="space-y-4">
          <div className="border-border-subtle rounded-lg border bg-white">
            <div className="border-border-subtle flex items-center justify-between border-b px-5 py-4">
              <div>
                <h2 className="text-sm font-semibold">Audit chain integrity</h2>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  Append-only, hash-chained, verifiable at any time.
                </p>
              </div>
              <span
                className={
                  chain.status === 'VERIFIED'
                    ? 'text-positive text-sm font-medium'
                    : 'text-negative text-sm font-medium'
                }
              >
                {chain.status === 'VERIFIED' ? 'Verified' : 'BROKEN'}
              </span>
            </div>
            <div className="space-y-2 px-5 py-4 text-sm">
              <p className="text-muted-foreground">
                <span className="tabular text-foreground font-medium">
                  {formatInteger(chain.entriesChecked)}
                </span>{' '}
                entries checked, sequence {chain.fromSequence.toString()} to{' '}
                {chain.toSequence.toString()}.
              </p>
              {chain.status === 'BROKEN' ? (
                <p className="text-negative">{chain.detail}</p>
              ) : (
                <p className="text-muted-foreground text-xs">
                  Every entry hash was recomputed from its stored fields and every signature
                  re-derived from the HMAC key.
                </p>
              )}
              {pendingSecurityEvents > 0 ? (
                <p className="text-warning">
                  {formatInteger(pendingSecurityEvents)} security event(s) awaiting acknowledgement.
                </p>
              ) : null}
            </div>
          </div>

          <div className="border-border-subtle rounded-lg border bg-white">
            <div className="border-border-subtle border-b px-5 py-4">
              <h2 className="text-sm font-semibold">Recent sign-ins</h2>
              <p className="text-muted-foreground mt-0.5 text-xs">
                Every attempt, successful or not, is recorded.
              </p>
            </div>
            {recentSignIns.length === 0 ? (
              <p className="text-muted-foreground px-5 py-4 text-sm">No sign-ins recorded yet.</p>
            ) : (
              <ul className="divide-border-subtle divide-y">
                {recentSignIns.map((entry, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm"
                  >
                    <span className="truncate">{entry.emailAttempted}</span>
                    <span className="tabular text-muted-foreground shrink-0 text-xs">
                      {entry.ipAddress ?? 'local'} - {formatDateTime(entry.occurredAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="border-border-subtle rounded-lg border bg-white lg:col-span-2">
          <div className="border-border-subtle border-b px-5 py-4 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold">Segregation of Duties exceptions</h2>
              <p className="text-muted-foreground mt-0.5 text-xs">
                Waivers granted for self-approval or preparer-as-approver situations.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge tone={pendingSodWaivers.length > 0 ? 'warning' : 'success'}>
                {pendingSodWaivers.length} pending
              </Badge>
              <Badge tone="info">{grantedSodWaivers.length} granted</Badge>
            </div>
          </div>
          <div className="px-5 py-4">
            {sodWaivers.length === 0 ? (
              <p className="text-muted-foreground text-sm">No SOD waivers recorded.</p>
            ) : (
              <ul className="divide-border-subtle divide-y">
                {sodWaivers.slice(0, 5).map((waiver) => (
                  <li key={waiver.id} className="py-3 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium truncate">{waiver.user.fullName}</span>
                        <span className="text-muted-foreground mono text-xs">
                          {waiver.user.emailNormalized}
                        </span>
                        <Badge
                          tone={
                            waiver.status === 'GRANTED'
                              ? 'success'
                              : waiver.status === 'REJECTED'
                              ? 'danger'
                              : 'warning'
                          }
                        >
                          {waiver.status}
                        </Badge>
                        <Badge tone="neutral" className="text-xs">
                          {waiver.approvalRequest?.entityType ?? 'Unknown'}
                        </Badge>
                      </div>
                      <p className="text-muted-foreground text-xs mt-1 truncate max-w-xs">
                        {waiver.reason}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        Recorded by {waiver.recordedBy.fullName} at {formatDateTime(waiver.recordedAt)} ({formatRelative(waiver.recordedAt)})
                        {waiver.reviewedAt ? ` • Reviewed by ${waiver.reviewedBy?.fullName ?? 'unknown'} at ${formatDateTime(waiver.reviewedAt)}` : ''}
                      </p>
                    </div>
                    {waiver.status === 'PENDING' && (
                      <a
                        href={`/approvals/${waiver.approvalRequest?.id}`}
                        className="text-navy-600 hover:text-navy-800 underline underline-offset-2 text-sm shrink-0"
                      >
                        Review
                      </a>
                    )}
                  </li>
                ))}
                {sodWaivers.length > 5 && (
                  <li className="py-3 text-center text-sm text-muted-foreground">
                    <a href="/admin/audit-trail" className="text-navy-600 hover:text-navy-800 underline">
                      View all {sodWaivers.length} waivers in audit trail
                    </a>
                  </li>
                )}
              </ul>
            )}
          </div>
        </div>

        <div className="border-border-subtle rounded-lg border bg-white">
          <div className="border-border-subtle border-b px-5 py-4">
            <h2 className="text-sm font-semibold">Awaiting your approval</h2>
            <p className="text-muted-foreground mt-0.5 text-xs">
              Requests where you are the assigned approver.
            </p>
          </div>
          <div className="px-5 py-4">
            {pendingApprovals === 0 ? (
              <p className="text-muted-foreground text-sm">Nothing awaiting your decision.</p>
            ) : (
              <div className="space-y-2">
                <p className="text-sm">
                  <span className="tabular text-foreground font-medium text-lg">{pendingApprovals}</span>{' '}
                  request{pendingApprovals !== 1 ? 's' : ''} awaiting decision.
                </p>
                <Link
                  href="/approvals?assignedToMe=true"
                  className="text-navy-600 hover:text-navy-800 underline underline-offset-2 text-sm"
                >
                  View inbox →
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="border-border-subtle rounded-lg border bg-white p-4">
          <h2 className="text-sm font-semibold mb-2">Risks & anomalies</h2>
          <div className="space-y-1 text-sm">
            <p>
              <span className="tabular text-foreground font-medium">{dashboard.openAnomalies}</span>{' '}
              open anomaly flag{dashboard.openAnomalies !== 1 ? 's' : ''}
            </p>
            <a href="/admin/anomalies" className="text-navy-600 hover:text-navy-800 underline underline-offset-2 text-sm">
              Review anomalies →
            </a>
          </div>
        </div>
        <div className="border-border-subtle rounded-lg border bg-white p-4">
          <h2 className="text-sm font-semibold mb-2">Compliance alerts</h2>
          <div className="text-sm text-muted-foreground">
            Credential expiry, tax filing deadlines, and regulatory alerts appear here once the compliance module lands (M13).
          </div>
        </div>
      </div>

      <PlannedPanel
        milestone="M5-M16"
        title="Approvals, risks and compliance"
        description="The CEO is the final approver for every amount in Phase 1. These queues appear as the underlying modules land."
        items={[
          'Pending approvals awaiting your decision',
          'Segregation-of-duties exceptions, including any waived self-posted item',
          'Over-budget requests needing approval',
          'Period close checklist and sign-off',
          'Compliance alerts and credential expiry',
        ]}
      />
    </div>
  );
}