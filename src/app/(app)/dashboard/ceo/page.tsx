import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { PlannedPanel, StatTile } from '@/components/planned';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { prisma } from '@/lib/db/prisma';
import { verifyChain } from '@/lib/audit/verifier';
import { formatInteger, formatDateTime, formatRelative } from '@/lib/format';
import { Badge } from '@/components/ui';
import { Prisma } from '@/generated/prisma/client';

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

  const [chain, recentSignIns, pendingSecurityEvents, org, sodWaivers, pendingApprovals] = await Promise.all([
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