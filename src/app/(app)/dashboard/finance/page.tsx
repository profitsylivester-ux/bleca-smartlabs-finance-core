import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui';
import { PlannedPanel, StatTile } from '@/components/planned';
import { requireContext, requirePageActor } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { prisma } from '@/lib/db/prisma';
import { formatDateTime } from '@/lib/format';

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

  const [failedLogins, openSecurityEvents, unverifiedUsers] = await Promise.all([
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Finance dashboard"
        description={`Signed in as ${actor.fullName}. Work waiting on you appears here first.`}
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Transactions awaiting action" unavailable="Not available" hint="M5" />
        <StatTile label="Reconciliation status" unavailable="Not available" hint="M8" />
        <StatTile label="Unpaid supplier bills" unavailable="Not available" hint="M10" />
        <StatTile label="Budget alerts" unavailable="Not available" hint="M9" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
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

        <PlannedPanel
          milestone="M5-M15"
          title="Your work queues"
          description="Each of these is a real workflow in the Phase 1 scope; none exists yet because the module behind it has not been built."
          items={[
            'Transactions to prepare, submit and post',
            'Bank and mobile money reconciliation sessions',
            'Invoices to raise and payments to record',
            'Documents to classify and match to transactions',
            'Budget preparation and revisions',
            'Month-end close checklist',
          ]}
        />
      </div>

      <p className="text-muted-foreground text-xs">
        {unverifiedUsers} active account(s) in this organisation
        {openSecurityEvents > 0 ? `, ${openSecurityEvents} unacknowledged security event(s)` : ''}.
      </p>
    </div>
  );
}
