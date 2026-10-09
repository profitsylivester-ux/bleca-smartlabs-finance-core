import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui';
import { PlannedPanel, StatTile } from '@/components/planned';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { prisma } from '@/lib/db/prisma';
import { verifyChain } from '@/lib/audit/verifier';
import { formatInteger, formatDateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'CEO dashboard' };

/**
 * CEO dashboard (PDF 61).
 *
 * Every figure on this page is currently UNAVAILABLE, and it says so rather than
 * showing zero. The distinction matters: this is a system whose whole premise is
 * that it never presents an absent number as a real one (the same rule that makes
 * unverified historical figures render as unverified). A tile reading "0" would
 * be a false statement about BLECA's position.
 */
export default async function CeoDashboardPage() {
  const ctx = await requireContext();
  await authorize(ctx, { module: 'DASHBOARD_CEO', action: 'VIEW' });

  const [chain, recentSignIns, pendingSecurityEvents, org] = await Promise.all([
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
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="CEO dashboard"
        description={`${org?.name ?? 'BLECA SmartLabs'} - executive position, approvals and risk.`}
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Cash and bank position" unavailable="Not available" hint="M7" />
        <StatTile label="Revenue, period to date" unavailable="Not available" hint="M4" />
        <StatTile label="Outstanding receivables" unavailable="Not available" hint="M11" />
        <StatTile label="Budget utilisation" unavailable="Not available" hint="M9" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <PlannedPanel
          milestone="M4-M16"
          title="Financial position"
          description="These figures appear once the double-entry core exists. They will be derived from posted journal entries, never entered by hand."
          items={[
            'Cash, bank and mobile money balances',
            'Revenue and expenses for the period',
            'Profit or loss',
            'Receivables and payables ageing',
            'Budget versus actual with commitment netting',
            'Funding runways for grants and sponsorships',
            'Project performance for Iventika and Uzanite',
          ]}
        />

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
