'use client';

/* eslint-disable react-hooks/set-state-in-effect */
import { useState, useEffect } from 'react';
import { Card, CardHeader, CardBody, Badge, Button, Alert, Table, Th, Td, EmptyState } from '@/components/ui';
import { formatAmount, formatDateTime, shortId } from '@/lib/format';
import { useRouter } from 'next/navigation';

type JournalEntry = {
  id: string;
  number: string | null;
  type: string;
  status: string;
  source: string;
  reference: string | null;
  description: string | null;
  postedAt: string | null;
  createdAt: string;
  updatedAt: string;
  period: { id: string; code: string; name: string; status: string } | null;
  lines: Array<{
    id: string;
    accountId: string;
    lineNumber: number;
    description: string | null;
    debit: number | string;
    credit: number | string;
    currencyCode: string;
    baseAmount: number | string;
    fxRate: number | string | null;
    projectId: string | null;
    departmentId: string | null;
    costCentreId: string | null;
    locationId: string | null;
    fundingSourceId: string | null;
    account: { id: string; code: string; name: string; type: string } | null;
    project: { id: string; code: string; name: string } | null;
    department: { id: string; code: string; name: string } | null;
    costCentre: { id: string; code: string; name: string } | null;
    location: { id: string; code: string; name: string } | null;
    fundingSource: { id: string; code: string; name: string } | null;
  }>;
  submittedBy: { id: string; fullName: string } | null;
  approvedBy: { id: string; fullName: string } | null;
  postedBy: { id: string; fullName: string } | null;
  reversedBy: { id: string; fullName: string } | null;
  reversalReason: { id: string; code: string; name: string } | null;
  adjustingEntry: { id: string; number: string } | null;
  balance: { debits: number; credits: number; balanced: boolean; difference: number };
  auditLog: Array<{
    id: string;
    action: string;
    createdAt: string;
    actorName: string;
    description: string;
    changes: Record<string, { from: unknown; to: unknown }>;
  }>;
};

function getStatusTone(status: string): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'DRAFT': return 'neutral';
    case 'SUBMITTED': return 'info';
    case 'APPROVED': return 'warning';
    case 'POSTED': return 'success';
    case 'LOCKED': return 'success';
    case 'REVERSED': return 'info';
    case 'VOIDED': return 'danger';
    case 'REJECTED': return 'danger';
    default: return 'neutral';
  }
}

const STATUS_FLOW = ['DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED', 'LOCKED'];

export default function JournalEntryDetailClient({ entryId }: { entryId: string }) {
  const router = useRouter();
  const [entry, setEntry] = useState<JournalEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchEntry = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/journal-entries/${entryId}`);
      if (!res.ok) throw new Error('Failed to fetch journal entry');
      const json = await res.json();
      setEntry(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEntry();
  }, [entryId]);

  const handleAction = async (action: string, data?: Record<string, unknown>) => {
    setActionLoading(action);
    try {
      const res = await fetch(`/api/v1/journal-entries/${entryId}/${action}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify(data || {}),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || `Failed to ${action}`);
      }
      await fetchEntry();
    } catch (err) {
      alert(err instanceof Error ? err.message : `Failed to ${action}`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleVoid = async () => {
    if (!confirm('Are you sure you want to void this journal entry? This action cannot be undone.')) return;
    await handleAction('void');
  };

  const handleReverse = async () => {
    router.push(`/accounting/journal-entries/${entryId}/reverse`);
  };

  const handleAdjust = async () => {
    if (!confirm('Create a correcting entry linked to this journal entry?')) return;
    await handleAction('adjust');
  };

  if (loading) {
    return (
      <Card>
        <CardBody className="py-12">
          <div className="text-center text-muted-foreground">Loading journal entry…</div>
        </CardBody>
      </Card>
    );
  }

  if (error || !entry) {
    return <Alert tone="danger" title="Failed to load journal entry">{error ?? 'Entry not found'}</Alert>;
  }

  const canEdit = entry.status === 'DRAFT';
  const canSubmit = entry.status === 'DRAFT';
  const canApprove = entry.status === 'SUBMITTED';
  const canPost = entry.status === 'APPROVED';
  const canReverse = entry.status === 'POSTED' || entry.status === 'LOCKED';
  const canVoid = entry.status === 'DRAFT' || entry.status === 'SUBMITTED' || entry.status === 'REJECTED' || entry.status === 'VOIDED';
  const canAdjust = entry.status === 'POSTED' || entry.status === 'LOCKED';

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title={entry.number ? `JE: ${entry.number}` : `Journal Entry ${shortId(entry.id)}`}
          description={`${entry.type} • ${entry.source}`}
          actions={
            <div className="flex items-center gap-2">
              <Badge tone={getStatusTone(entry.status)} className="text-sm px-3 py-1">{entry.status}</Badge>
              {canEdit && (
                <Button variant="outline" size="sm" onClick={() => router.push(`/accounting/journal-entries/${entryId}/edit`)}>
                  Edit
                </Button>
              )}
            </div>
          }
        />
        <CardBody className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 text-sm">
            <div><span className="text-muted-foreground">Period</span><br />{entry.period?.code ?? '-'}</div>
            <div><span className="text-muted-foreground">Reference</span><br />{entry.reference ?? '-'}</div>
            <div><span className="text-muted-foreground">Description</span><br />{entry.description ?? '-'}</div>
            <div><span className="text-muted-foreground">Created</span><br />{formatDateTime(entry.createdAt)}</div>
            <div><span className="text-muted-foreground">Posted</span><br />{entry.postedAt ? formatDateTime(entry.postedAt) : '-'}</div>
            <div><span className="text-muted-foreground">Balance</span><br />
              <Badge tone={entry.balance.balanced ? 'success' : 'danger'}>
                {entry.balance.balanced ? 'Balanced' : `Diff: ${formatAmount(entry.balance.difference)}`}
              </Badge>
            </div>
          </div>

          <div className="border-t pt-4">
            <h3 className="text-sm font-semibold mb-2">Status Timeline</h3>
            <div className="flex items-center gap-2 overflow-x-auto pb-2">
              {STATUS_FLOW.map((status, idx) => {
                const isCurrent = status === entry.status;
                const isPast = STATUS_FLOW.indexOf(entry.status) > idx;
                const isReversed = entry.status === 'REVERSED' && status === 'POSTED';
                return (
                  <div key={status} className="flex items-center flex-shrink-0">
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-medium ${
                        isCurrent || isPast || isReversed
                          ? 'bg-navy-800 text-white'
                          : 'bg-surface-muted text-muted-foreground'
                      }`}
                    >
                      {idx + 1}
                    </div>
                    <span className={`ml-1 whitespace-nowrap text-xs ${isCurrent ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
                      {status}
                    </span>
                    {idx < STATUS_FLOW.length - 1 && (
                      <div
                        className={`w-16 h-0.5 mx-1 ${isPast || isReversed ? 'bg-navy-800' : 'bg-border-subtle'}`}
                      />
                    )}
                  </div>
                );
              })}
              {entry.status === 'REVERSED' && (
                <div className="flex items-center flex-shrink-0 ml-2">
                  <div className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-medium bg-navy-800 text-white">↩</div>
                  <span className="ml-1 whitespace-nowrap text-xs font-semibold text-foreground">REVERSED</span>
                </div>
              )}
              {['VOIDED', 'REJECTED'].includes(entry.status) && (
                <div className="flex items-center flex-shrink-0 ml-2">
                  <div className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-medium bg-red-500 text-white">✕</div>
                  <span className="ml-1 whitespace-nowrap text-xs font-semibold text-danger">{entry.status}</span>
                </div>
              )}
            </div>
          </div>

          <div className="border-t pt-4">
            <h3 className="text-sm font-semibold mb-2">Actors</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div><span className="text-muted-foreground">Submitted by</span><br />{entry.submittedBy?.fullName ?? '-'}</div>
              <div><span className="text-muted-foreground">Approved by</span><br />{entry.approvedBy?.fullName ?? '-'}</div>
              <div><span className="text-muted-foreground">Posted by</span><br />{entry.postedBy?.fullName ?? '-'}</div>
              <div><span className="text-muted-foreground">Reversed by</span><br />{entry.reversedBy?.fullName ?? '-'}</div>
            </div>
          </div>

          {entry.reversalReason && (
            <div className="border-t pt-4">
              <h3 className="text-sm font-semibold mb-2">Reversal Reason</h3>
              <p className="text-sm">{entry.reversalReason.code}: {entry.reversalReason.name}</p>
            </div>
          )}

          {entry.adjustingEntry && (
            <div className="border-t pt-4">
              <h3 className="text-sm font-semibold mb-2">Adjusting Entry</h3>
              <p className="text-sm">Linked to correcting entry: {entry.adjustingEntry.number}</p>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Lines" description={`${entry.lines.length} lines • Debits: ${formatAmount(entry.balance.debits)} • Credits: ${formatAmount(entry.balance.credits)}`} />
        <CardBody>
          {entry.lines.length === 0 ? (
            <EmptyState title="No lines" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>#</Th>
                  <Th>Account</Th>
                  <Th>Description</Th>
                  <Th className="text-right">Debit</Th>
                  <Th className="text-right">Credit</Th>
                  <Th>Currency</Th>
                  <Th>Project</Th>
                  <Th>Department</Th>
                  <Th>Cost Centre</Th>
                  <Th>Location</Th>
                  <Th>Funding Source</Th>
                </tr>
              </thead>
              <tbody>
                {entry.lines.map((line) => (
                  <tr key={line.id}>
                    <Td>{line.lineNumber}</Td>
                    <Td>{line.account?.code} - {line.account?.name}</Td>
                    <Td>{line.description ?? '-'}</Td>
                    <Td className="text-right font-mono">{formatAmount(Number(line.debit), line.currencyCode)}</Td>
                    <Td className="text-right font-mono">{formatAmount(Number(line.credit), line.currencyCode)}</Td>
                    <Td>{line.currencyCode}</Td>
                    <Td>{line.project?.code ?? '-'}</Td>
                    <Td>{line.department?.code ?? '-'}</Td>
                    <Td>{line.costCentre?.code ?? '-'}</Td>
                    <Td>{line.location?.code ?? '-'}</Td>
                    <Td>{line.fundingSource?.code ?? '-'}</Td>
                  </tr>
                ))}
                <tr className="font-semibold bg-surface-muted">
                  <Td colSpan={3} className="text-right">Totals</Td>
                  <Td className="text-right font-mono">{formatAmount(entry.balance.debits)}</Td>
                  <Td className="text-right font-mono">{formatAmount(entry.balance.credits)}</Td>
                  <Td colSpan={6}></Td>
                </tr>
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>

      {entry.status !== 'VOIDED' && entry.status !== 'REJECTED' && (
        <Card>
          <CardHeader title="Actions" description="Available actions based on current status." />
          <CardBody>
            <div className="flex flex-wrap gap-2">
              {canSubmit && (
                <Button onClick={() => handleAction('submit')} disabled={actionLoading === 'submit'}>
                  {actionLoading === 'submit' ? 'Submitting…' : 'Submit'}
                </Button>
              )}
              {canApprove && (
                <Button onClick={() => handleAction('approve')} disabled={actionLoading === 'approve'}>
                  {actionLoading === 'approve' ? 'Approving…' : 'Approve'}
                </Button>
              )}
              {canPost && (
                <Button onClick={() => handleAction('post')} disabled={actionLoading === 'post'}>
                  {actionLoading === 'post' ? 'Posting…' : 'Post'}
                </Button>
              )}
              {canReverse && (
                <Button variant="outline" onClick={handleReverse} disabled={actionLoading === 'reverse'}>
                  {actionLoading === 'reverse' ? 'Reversing…' : 'Reverse'}
                </Button>
              )}
              {canAdjust && (
                <Button variant="outline" onClick={handleAdjust} disabled={actionLoading === 'adjust'}>
                  {actionLoading === 'adjust' ? 'Adjusting…' : 'Adjust'}
                </Button>
              )}
              {canVoid && (
                <Button variant="danger" onClick={handleVoid} disabled={actionLoading === 'void'}>
                  {actionLoading === 'void' ? 'Voiding…' : 'Void'}
                </Button>
              )}
            </div>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="Audit Trail" description="All actions performed on this journal entry." />
        <CardBody>
          {entry.auditLog && entry.auditLog.length > 0 ? (
            <Table>
              <thead>
                <tr>
                  <Th>Timestamp</Th>
                  <Th>Action</Th>
                  <Th>Actor</Th>
                  <Th>Description</Th>
                  <Th>Changes</Th>
                </tr>
              </thead>
              <tbody>
                {entry.auditLog.map((log) => (
                  <tr key={log.id}>
                    <Td>{formatDateTime(log.createdAt)}</Td>
                    <Td><Badge tone="neutral">{log.action}</Badge></Td>
                    <Td>{log.actorName}</Td>
                    <Td>{log.description}</Td>
                    <Td>
                      <pre className="text-[11px] max-h-24 overflow-auto">{JSON.stringify(log.changes, null, 2)}</pre>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <EmptyState title="No audit entries" body="Audit trail will appear after actions are performed." />
          )}
        </CardBody>
      </Card>
    </div>
  );
}