import type { Metadata } from 'next';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { prisma } from '@/lib/db/prisma';
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader } from '@/components/ui';
import { formatDate, formatDateTime } from '@/lib/format';
import { CreateDelegationForm } from '@/modules/users-roles/components/forms';

export const metadata: Metadata = { title: 'Delegated authority' };

export default async function DelegationsPage() {
  const ctx = await requireContext();
  await authorize(ctx, { module: 'USERS_ROLES', action: 'VIEW' });

  const now = new Date();

  const [delegations, users, roles] = await Promise.all([
    prisma.delegation.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        kind: true,
        reason: true,
        startsAt: true,
        expiresAt: true,
        revokedAt: true,
        revocationReason: true,
        grantor: { select: { fullName: true } },
        grantee: { select: { fullName: true, emailNormalized: true } },
        role: { select: { code: true } },
      },
    }),
    prisma.user.findMany({
      where: { isActive: true, deletedAt: null },
      orderBy: { fullName: 'asc' },
      select: { id: true, emailNormalized: true },
    }),
    prisma.role.findMany({
      where: { isActive: true },
      orderBy: { code: 'asc' },
      select: { id: true, code: true },
    }),
  ]);

  const live = delegations.filter((d) => !d.revokedAt && d.startsAt <= now && d.expiresAt > now);
  const expired = delegations.filter((d) => !d.revokedAt && d.expiresAt <= now);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Delegated authority"
        description="How authority moves between people when the CEO is unavailable. Every delegation has a mandatory expiry."
      />

      <Card>
        <CardHeader
          title="Create a delegation"
          description="Grants a role, never a raw permission set, so its reach is always describable."
        />
        <CardBody>
          <CreateDelegationForm users={users} roles={roles} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={`Live delegations (${live.length})`}
          description="Active right now and granting authority."
        />
        <CardBody className="px-0 py-0">
          {live.length === 0 ? (
            <EmptyState
              title="No live delegations"
              body="When the CEO is unavailable, create one here rather than sharing credentials."
            />
          ) : (
            <ul className="divide-border-subtle divide-y">
              {live.map((d) => (
                <li key={d.id} className="px-5 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{d.grantee.fullName}</span>
                    <Badge tone="info">holds {d.role?.code ?? 'unknown role'}</Badge>
                    <Badge tone="neutral">{d.kind.replace(/_/g, ' ').toLowerCase()}</Badge>
                  </div>
                  <p className="text-muted-foreground mt-1 text-xs">
                    Granted by {d.grantor.fullName}. Runs {formatDate(d.startsAt)} to{' '}
                    {formatDate(d.expiresAt)}.
                  </p>
                  <p className="text-muted-foreground mt-0.5 text-xs">Reason: {d.reason}</p>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {expired.length > 0 ? (
        <Card>
          <CardHeader
            title={`Expired but not revoked (${expired.length})`}
            description="Already inert. Revoking records the decision rather than leaving them to lapse silently."
          />
          <CardBody className="px-0 py-0">
            <ul className="divide-border-subtle divide-y">
              {expired.map((d) => (
                <li key={d.id} className="px-5 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{d.grantee.emailNormalized}</span>
                    <Badge tone="neutral">{d.role?.code}</Badge>
                    <Badge tone="warning">Expired {formatDateTime(d.expiresAt)}</Badge>
                  </div>
                  <p className="text-muted-foreground mt-0.5 text-xs">Reason: {d.reason}</p>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
