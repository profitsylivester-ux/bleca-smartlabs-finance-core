import type { Metadata } from 'next';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { prisma } from '@/lib/db/prisma';
import { scopeWhereFor } from '@/lib/kernel/authorize';
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader } from '@/components/ui';
import { formatDateTime, shortId } from '@/lib/format';
import { VerifyChainButton } from '@/modules/audit-trail/components/verify-button';

export const metadata: Metadata = { title: 'Audit trail' };

const PAGE_SIZE = 100;

const RESULT_TONE = {
  SUCCESS: 'success',
  FAILURE: 'danger',
  DENIED: 'danger',
  PARTIAL: 'warning',
} as const;

/**
 * Audit trail (PDF 54, PDF 49).
 *
 * Three properties are visible on this screen rather than merely claimed:
 * the hash chain head, the per-entry signature, and the fact that entries cannot
 * be edited. The last one is enforced by a database trigger, so there is no
 * button here to edit anything - not because the UI hides it, but because the
 * database would refuse it.
 */
export default async function AuditTrailPage({
  searchParams,
}: {
  searchParams: Promise<{ result?: string; action?: string; actor?: string; page?: string }>;
}) {
  const ctx = await requireContext();
  await authorize(ctx, {
    module: 'AUDIT_TRAIL',
    action: 'VIEW',
    entity: { type: 'AUDIT_LOG' },
  });

  const params = await searchParams;
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1);

  const where = {
    ...(params.result
      ? { result: params.result as 'SUCCESS' | 'FAILURE' | 'DENIED' | 'PARTIAL' }
      : {}),
    ...(params.action ? { action: params.action as never } : {}),
    ...(params.actor
      ? { actorName: { contains: params.actor, mode: 'insensitive' as const } }
      : {}),
  };

  const [entries, total, head, lastCheckpoint, scope] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { sequence: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        sequence: true,
        previousHash: true,
        entryHash: true,
        signature: true,
        actorName: true,
        actorRoleCodes: true,
        action: true,
        entityType: true,
        entityId: true,
        entityLabel: true,
        description: true,
        result: true,
        channel: true,
        ipAddress: true,
        occurredAt: true,
        recordedAt: true,
      },
    }),
    prisma.auditLog.count({ where }),
    prisma.auditChainHead.findUnique({
      where: { id: 1 },
      select: { sequence: true, entryHash: true },
    }),
    prisma.auditChainCheckpoint.findFirst({
      orderBy: { sealedAt: 'desc' },
      select: {
        status: true,
        sealedAt: true,
        sealedThroughSequence: true,
        entriesChecked: true,
        detail: true,
      },
    }),
    scopeWhereFor(ctx, 'AUDIT_TRAIL', 'VIEW'),
  ]);

  void scope;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit trail"
        description="Append-only and hash-chained. Entries cannot be edited or deleted - the database refuses it, not just the interface."
        actions={<VerifyChainButton canVerify={ctx.actor.isFinalApprover} />}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Chain head" description="The most recent entry hash in the chain." />
          <CardBody className="space-y-2 text-sm">
            <p>
              <span className="text-muted-foreground">Sequence: </span>
              <span className="tabular font-medium">{head?.sequence.toString() ?? '0'}</span>
            </p>
            <p className="mono text-muted-foreground text-xs break-all">
              {head?.entryHash ?? '(empty)'}
            </p>
            <p className="text-muted-foreground text-xs">
              Each entry&apos;s hash covers the previous hash, so a change to any entry breaks every
              link after it.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Last verification"
            description="Seals make verification incremental."
          />
          <CardBody className="space-y-2 text-sm">
            {lastCheckpoint ? (
              <>
                <p className="flex items-center gap-2">
                  <Badge tone={lastCheckpoint.status === 'VERIFIED' ? 'success' : 'danger'}>
                    {lastCheckpoint.status}
                  </Badge>
                  <span className="text-muted-foreground text-xs">
                    {formatDateTime(lastCheckpoint.sealedAt)}
                  </span>
                </p>
                <p className="text-muted-foreground text-xs">
                  {lastCheckpoint.entriesChecked} entries through sequence{' '}
                  {lastCheckpoint.sealedThroughSequence.toString()}.
                </p>
                {lastCheckpoint.detail ? (
                  <p className="text-negative text-xs">{lastCheckpoint.detail}</p>
                ) : null}
              </>
            ) : (
              <p className="text-muted-foreground text-xs">
                No seal has been taken yet. Use &ldquo;Verify chain&rdquo; to check the whole
                history.
              </p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Showing" description="Filtered view of the chain." />
          <CardBody className="space-y-2 text-sm">
            <p>
              <span className="tabular font-medium">{total}</span> entries match the current filter.
            </p>
            <p className="text-muted-foreground text-xs">
              Page {page} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}. Filtering, viewing and
              exporting the audit trail are themselves audited.
            </p>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Entries" description="Newest first." />
        <CardBody className="px-0 py-0">
          {entries.length === 0 ? (
            <EmptyState title="No audit entries yet" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr>
                    <th className="border-border-subtle text-muted-foreground border-b px-3 py-2 text-[11px] font-semibold tracking-wide uppercase">
                      Seq
                    </th>
                    <th className="border-border-subtle text-muted-foreground border-b px-3 py-2 text-[11px] font-semibold tracking-wide uppercase">
                      When
                    </th>
                    <th className="border-border-subtle text-muted-foreground border-b px-3 py-2 text-[11px] font-semibold tracking-wide uppercase">
                      Actor
                    </th>
                    <th className="border-border-subtle text-muted-foreground border-b px-3 py-2 text-[11px] font-semibold tracking-wide uppercase">
                      Action
                    </th>
                    <th className="border-border-subtle text-muted-foreground border-b px-3 py-2 text-[11px] font-semibold tracking-wide uppercase">
                      Description
                    </th>
                    <th className="border-border-subtle text-muted-foreground border-b px-3 py-2 text-[11px] font-semibold tracking-wide uppercase">
                      Result
                    </th>
                    <th className="border-border-subtle text-muted-foreground border-b px-3 py-2 text-[11px] font-semibold tracking-wide uppercase">
                      Integrity
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.id}>
                      <td className="tabular border-border-subtle border-b px-3 py-2 align-top text-xs">
                        {entry.sequence.toString()}
                      </td>
                      <td className="border-border-subtle border-b px-3 py-2 align-top text-xs whitespace-nowrap">
                        {formatDateTime(entry.occurredAt)}
                      </td>
                      <td className="border-border-subtle border-b px-3 py-2 align-top text-xs">
                        {entry.actorName ?? 'system'}
                        {entry.actorRoleCodes.length > 0 ? (
                          <span className="text-muted-foreground block text-[10px]">
                            {entry.actorRoleCodes.join(', ')}
                          </span>
                        ) : null}
                      </td>
                      <td className="border-border-subtle border-b px-3 py-2 align-top">
                        <span className="mono text-xs">{entry.action}</span>
                        <span className="text-muted-foreground block text-[10px]">
                          {entry.entityType}
                          {entry.entityId ? ` / ${shortId(entry.entityId, 6)}` : ''}
                        </span>
                      </td>
                      <td className="border-border-subtle border-b px-3 py-2 align-top text-xs">
                        {entry.description}
                        <span className="text-muted-foreground block text-[10px]">
                          {entry.channel}
                          {entry.ipAddress ? ` - ${entry.ipAddress}` : ''}
                        </span>
                      </td>
                      <td className="border-border-subtle border-b px-3 py-2 align-top">
                        <Badge tone={RESULT_TONE[entry.result] ?? 'neutral'}>{entry.result}</Badge>
                      </td>
                      <td className="border-border-subtle border-b px-3 py-2 align-top">
                        <span
                          className="mono text-muted-foreground block text-[10px]"
                          title={`entry hash: ${entry.entryHash}`}
                        >
                          {entry.entryHash.slice(0, 12)}...
                        </span>
                        <span
                          className="mono text-muted-foreground block text-[10px]"
                          title={`signature: ${entry.signature}`}
                        >
                          sig {entry.signature.slice(0, 12)}...
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
