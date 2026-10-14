import type { Metadata } from 'next';
import { requireContext } from '@/lib/auth/guard';
import { prisma } from '@/lib/db/prisma';
import { Card, CardBody, CardHeader, EmptyState, PageHeader } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import RestoreButton from './RestoreButton';

export const metadata: Metadata = { title: 'Trash' };

export default async function TrashPage() {
  const ctx = await requireContext();
  const orgId = ctx.actor.organizationId!;

  const allApproved = await prisma.masterDataChangeRequest.findMany({
    where: { organizationId: orgId, status: 'APPROVED' },
    orderBy: { approvedAt: 'desc' },
    take: 100,
    select: { id: true, entityType: true, entityId: true, reason: true, approvedAt: true, createdAt: true, proposedChanges: true },
  });
  const items = allApproved.filter((it) => {
    const pc = it.proposedChanges as Record<string, unknown> | null;
    return pc && typeof pc === 'object' && 'deletedAt' in pc;
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Trash"
        description="Deleted Business Setup records. Restorable for 90 days from the approval date."
      />
      <Card>
        <CardHeader title={`Deleted items (${items.length})`} />
        <CardBody className="px-0 py-0">
          {items.length === 0 ? (
            <EmptyState title="Trash is empty" body="Nothing has been deleted yet." />
          ) : (
            <ul className="divide-border-subtle divide-y">
              {items.map((it) => {
                const approvedAt = it.approvedAt ?? it.createdAt;
                const daysSince = Math.floor((Date.now() - new Date(approvedAt).getTime()) / (1000 * 60 * 60 * 24));
                const daysLeft = Math.max(0, 90 - daysSince);
                const expired = daysLeft <= 0;
                return (
                  <li key={it.id} className="px-5 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium mono text-sm">{it.entityType}</span>
                        {it.entityId && <span className="text-muted-foreground mono text-xs">#{it.entityId.slice(0, 8)}</span>}
                      </div>
                      <span className="text-xs text-muted-foreground">
                        Deleted {formatDateTime(new Date(approvedAt))} · {expired ? 'Purge due' : `${daysLeft} days left`}
                      </span>
                    </div>
                    <p className="text-muted-foreground mt-1 text-sm">{it.reason}</p>
                    <div className="mt-2">
                      <RestoreButton changeId={it.id} disabled={expired} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
