'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Card, CardHeader, CardBody, Badge, Button, Alert, Table, Th, Td, EmptyState } from '@/components/ui';
import { formatAmount, formatDate, formatDateTime, shortId } from '@/lib/format';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

type Transaction = {
  id: string;
  status: string | null;
  date: string;
  description: string | null;
  reference: string | null;
  amount: number;
  currencyCode: string;
  paymentMethod: string;
  accountId: string | null;
  projectId: string | null;
  departmentId: string | null;
  costCentreId: string | null;
  fundingSourceId: string | null;
  supportingDocumentId: string | null;
  createdAt: string;
  updatedAt: string;
  account: { id: string; code: string; name: string; type: string; requiresDocument: boolean } | null;
  project: { id: string; code: string; name: string } | null;
  department: { id: string; code: string; name: string } | null;
  costCentre: { id: string; code: string; name: string } | null;
  fundingSource: { id: string; code: string; name: string } | null;
  createdBy: { id: string; fullName: string } | null;
  submittedBy: { id: string; fullName: string } | null;
  approvedBy: { id: string; fullName: string } | null;
  postedBy: { id: string; fullName: string } | null;
  journalEntry: {
    id: string;
    number: string | null;
    status: string;
    lines: Array<{
      id: string;
      lineNumber: number;
      accountId: string;
      description: string | null;
      debit: number | string;
      credit: number | string;
      currencyCode: string;
      account: { id: string; code: string; name: string } | null;
      project: { id: string; code: string; name: string } | null;
      department: { id: string; code: string; name: string } | null;
      costCentre: { id: string; code: string; name: string } | null;
      fundingSource: { id: string; code: string; name: string } | null;
    }>;
    balance: { debits: number; credits: number; balanced: boolean; difference: number };
  } | null;
  auditLog: Array<{
    id: string;
    action: string;
    createdAt: string;
    actorName: string;
    description: string;
    changes: Record<string, { from: unknown; to: unknown }>;
    metadata: Record<string, unknown> | null;
  }>;
};

const STATUS_FLOW = ['DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED', 'LOCKED', 'ADJUSTED', 'REVERSED'];

function getStatusTone(status: string | null): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'DRAFT': return 'neutral';
    case 'SUBMITTED': return 'info';
    case 'APPROVED': return 'warning';
    case 'POSTED': return 'success';
    case 'LOCKED': return 'success';
    case 'ADJUSTED': return 'info';
    case 'REVERSED': return 'info';
    case 'REJECTED': return 'danger';
    case 'CANCELLED': return 'danger';
    default: return 'neutral';
  }
}

export default function TransactionDetailClient({ transactionId }: { transactionId: string }) {
  const router = useRouter();
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchTransaction = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/transactions/${transactionId}?detail=full`);
      if (!res.ok) throw new Error('Failed to fetch transaction');
      const json = await res.json();
      setTransaction(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [transactionId]);

  const fetchRef = useRef(fetchTransaction);
  useEffect(() => {
    fetchRef.current = fetchTransaction;
  }, [fetchTransaction]);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchRef.current();
    }, 0);
    return () => clearTimeout(timer);
  }, [fetchTransaction]);

  const handleAction = async (action: string, data?: Record<string, unknown>) => {
    setActionLoading(action);
    try {
      const res = await fetch(`/api/v1/transactions/${transactionId}/${action}`, {
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
      await fetchTransaction();
    } catch (err) {
      alert(err instanceof Error ? err.message : `Failed to ${action}`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleSubmit = async () => {
    if (!confirm('Submit this transaction for approval?')) return;
    await handleAction('submit');
  };

  const handleApprove = async () => {
    if (!confirm('Approve this transaction?')) return;
    await handleAction('approve');
  };

  const handleReject = async () => {
    if (!confirm('Reject this transaction? This will return it to draft state.')) return;
    await handleAction('reject');
  };

  const handlePost = async () => {
    if (!confirm('Post this transaction? This will create a journal entry and update balances.')) return;
    await handleAction('post');
  };

  const handleCancel = async () => {
    if (!confirm('Cancel this transaction? This action cannot be undone.')) return;
    await handleAction('cancel');
  };

  const navigateAdjust = () => router.push(`/transactions/${transactionId}/adjust`);
  const navigateReverse = () => router.push(`/transactions/${transactionId}/reverse`);

  if (loading) {
    return (
      <Card>
        <CardBody className="py-12">
          <div className="text-center text-muted-foreground">Loading transaction…</div>
        </CardBody>
      </Card>
    );
  }

  if (error || !transaction) {
    return <Alert tone="danger" title="Failed to load transaction">{error ?? 'Transaction not found'}</Alert>;
  }

  const canSubmit = transaction.status === 'DRAFT';
  const canApprove = transaction.status === 'SUBMITTED';
  const canReject = transaction.status === 'SUBMITTED' || transaction.status === 'APPROVED';
  const canPost = transaction.status === 'APPROVED';
  const canCancel = transaction.status === 'DRAFT' || transaction.status === 'SUBMITTED' || transaction.status === 'REJECTED';
  const canAdjust = transaction.status === 'POSTED' || transaction.status === 'LOCKED';
  const canReverse = transaction.status === 'POSTED' || transaction.status === 'LOCKED';

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title={transaction.reference ? `TXN: ${transaction.reference}` : `Transaction ${shortId(transaction.id)}`}
          description={`Amount: ${formatAmount(transaction.amount, transaction.currencyCode)} • ${transaction.paymentMethod}`}
          actions={
            <div className="flex items-center gap-2">
              <Badge tone={getStatusTone(transaction.status)} className="text-sm px-3 py-1">
                {transaction.status ?? 'DRAFT'}
              </Badge>
              {canSubmit && (
                <Button size="sm" onClick={handleSubmit} disabled={actionLoading === 'submit'}>
                  {actionLoading === 'submit' ? 'Submitting…' : 'Submit'}
                </Button>
              )}
              {canApprove && (
                <Button size="sm" onClick={handleApprove} disabled={actionLoading === 'approve'}>
                  {actionLoading === 'approve' ? 'Approving…' : 'Approve'}
                </Button>
              )}
              {canReject && (
                <Button variant="outline" size="sm" onClick={handleReject} disabled={actionLoading === 'reject'}>
                  {actionLoading === 'reject' ? 'Rejecting…' : 'Reject'}
                </Button>
              )}
              {canPost && (
                <Button size="sm" onClick={handlePost} disabled={actionLoading === 'post'}>
                  {actionLoading === 'post' ? 'Posting…' : 'Post'}
                </Button>
              )}
              {canCancel && (
                <Button variant="danger" size="sm" onClick={handleCancel} disabled={actionLoading === 'cancel'}>
                  {actionLoading === 'cancel' ? 'Cancelling…' : 'Cancel'}
                </Button>
              )}
              {canAdjust && (
                <Button variant="outline" size="sm" onClick={navigateAdjust}>
                  Adjust
                </Button>
              )}
              {canReverse && (
                <Button variant="outline" size="sm" onClick={navigateReverse}>
                  Reverse
                </Button>
              )}
            </div>
          }
        />
        <CardBody className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 text-sm">
            <div><span className="text-muted-foreground">Date</span><br />{formatDate(transaction.date)}</div>
            <div><span className="text-muted-foreground">Reference</span><br />{transaction.reference ?? '-'}</div>
            <div><span className="text-muted-foreground">Description</span><br />{transaction.description ?? '-'}</div>
            <div><span className="text-muted-foreground">Account</span><br />{transaction.account?.code ?? transaction.accountId ?? '-'}</div>
            <div><span className="text-muted-foreground">Project</span><br />{transaction.project?.code ?? transaction.projectId ?? '-'}</div>
            <div><span className="text-muted-foreground">Department</span><br />{transaction.department?.code ?? transaction.departmentId ?? '-'}</div>
            <div><span className="text-muted-foreground">Cost Centre</span><br />{transaction.costCentre?.code ?? transaction.costCentreId ?? '-'}</div>
            <div><span className="text-muted-foreground">Funding Source</span><br />{transaction.fundingSource?.code ?? transaction.fundingSourceId ?? '-'}</div>
            <div><span className="text-muted-foreground">Payment Method</span><br />{transaction.paymentMethod}</div>
            <div><span className="text-muted-foreground">Supporting Doc</span><br />{transaction.supportingDocumentId ?? '-'}</div>
            <div><span className="text-muted-foreground">Created</span><br />{formatDateTime(transaction.createdAt)}</div>
            <div><span className="text-muted-foreground">Updated</span><br />{formatDateTime(transaction.updatedAt)}</div>
          </div>

          <div className="border-t pt-4">
            <h3 className="text-sm font-semibold mb-2">Status Timeline</h3>
            <div className="flex items-center gap-2 overflow-x-auto pb-2">
              {STATUS_FLOW.map((status, idx) => {
                const isCurrent = status === transaction.status;
                const isPast = STATUS_FLOW.indexOf(transaction.status || 'DRAFT') > idx;
                const isReversed = transaction.status === 'REVERSED' && status === 'POSTED';
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
              {transaction.status === 'REVERSED' && (
                <div className="flex items-center flex-shrink-0 ml-2">
                  <div className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-medium bg-navy-800 text-white">↩</div>
                  <span className="ml-1 whitespace-nowrap text-xs font-semibold text-foreground">REVERSED</span>
                </div>
              )}
              {['REJECTED', 'CANCELLED'].includes(transaction.status || '') && (
                <div className="flex items-center flex-shrink-0 ml-2">
                  <div className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-medium bg-red-500 text-white">✕</div>
                  <span className="ml-1 whitespace-nowrap text-xs font-semibold text-danger">{transaction.status}</span>
                </div>
              )}
            </div>
          </div>

          <div className="border-t pt-4">
            <h3 className="text-sm font-semibold mb-2">Actors</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div><span className="text-muted-foreground">Created by</span><br />{transaction.createdBy?.fullName ?? '-'}</div>
              <div><span className="text-muted-foreground">Submitted by</span><br />{transaction.submittedBy?.fullName ?? '-'}</div>
              <div><span className="text-muted-foreground">Approved by</span><br />{transaction.approvedBy?.fullName ?? '-'}</div>
              <div><span className="text-muted-foreground">Posted by</span><br />{transaction.postedBy?.fullName ?? '-'}</div>
            </div>
          </div>

          {transaction.journalEntry && (
            <div className="border-t pt-4">
              <h3 className="text-sm font-semibold mb-2">Journal Entry Preview</h3>
              <div className="space-y-2">
                <div className="grid grid-cols-4 gap-4 text-sm">
                  <div><span className="text-muted-foreground">Entry Number</span><br />{transaction.journalEntry.number ?? 'Not posted'}</div>
                  <div><span className="text-muted-foreground">Status</span><br />
                    <Badge tone={getStatusTone(transaction.journalEntry.status)}>{transaction.journalEntry.status}</Badge>
                  </div>
                  <div><span className="text-muted-foreground">Lines</span><br />{transaction.journalEntry.lines.length}</div>
                  <div><span className="text-muted-foreground">Balance</span><br />
                    <Badge tone={transaction.journalEntry.balance.balanced ? 'success' : 'danger'}>
                      {transaction.journalEntry.balance.balanced ? 'Balanced' : `Diff: ${formatAmount(transaction.journalEntry.balance.difference)}`}
                    </Badge>
                  </div>
                </div>
                {transaction.journalEntry.lines.length > 0 && (
                  <Table>
                    <thead>
                      <tr>
                        <Th>#</Th>
                        <Th>Account</Th>
                        <Th>Description</Th>
                        <Th className="text-right">Debit</Th>
                        <Th className="text-right">Credit</Th>
                        <Th>Project</Th>
                        <Th>Department</Th>
                        <Th>Cost Centre</Th>
                        <Th>Funding Source</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {transaction.journalEntry.lines.map((line) => (
                        <tr key={line.id}>
                          <Td>{line.lineNumber}</Td>
                          <Td>{line.account?.code ?? line.accountId} - {line.account?.name ?? ''}</Td>
                          <Td>{line.description ?? '-'}</Td>
                          <Td className="text-right font-mono">{formatAmount(Number(line.debit), line.currencyCode)}</Td>
                          <Td className="text-right font-mono">{formatAmount(Number(line.credit), line.currencyCode)}</Td>
                          <Td>{line.project?.code ?? '-'}</Td>
                          <Td>{line.department?.code ?? '-'}</Td>
                          <Td>{line.costCentre?.code ?? '-'}</Td>
                          <Td>{line.fundingSource?.code ?? '-'}</Td>
                        </tr>
                      ))}
                      <tr className="font-semibold bg-surface-muted">
                        <Td colSpan={3} className="text-right">Totals</Td>
                        <Td className="text-right font-mono">{formatAmount(transaction.journalEntry.balance.debits)}</Td>
                        <Td className="text-right font-mono">{formatAmount(transaction.journalEntry.balance.credits)}</Td>
                        <Td colSpan={4}></Td>
                      </tr>
                    </tbody>
                  </Table>
                )}
                <div className="flex gap-2">
                  {transaction.journalEntry.number && (
                    <Link href={`/accounting/journal-entries/${transaction.journalEntry.id}`}>
                      <Button variant="outline" size="sm">View Full Journal Entry</Button>
                    </Link>
                  )}
                </div>
              </div>
            </div>
          )}

          {transaction.supportingDocumentId && (
            <div className="border-t pt-4">
              <h3 className="text-sm font-semibold mb-2">Supporting Document</h3>
              <Link href={`/documents/${transaction.supportingDocumentId}`}>
                <Button variant="outline" size="sm">View Document</Button>
              </Link>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Audit Trail" description="All actions performed on this transaction." />
        <CardBody>
          {transaction.auditLog && transaction.auditLog.length > 0 ? (
            <Table>
              <thead>
                <tr>
                  <Th>Timestamp</Th>
                  <Th>Action</Th>
                  <Th>Actor</Th>
                  <Th>Description</Th>
                  <Th>Changes / Metadata</Th>
                </tr>
              </thead>
              <tbody>
                {transaction.auditLog.map((log) => (
                  <tr key={log.id}>
                    <Td>{formatDateTime(log.createdAt)}</Td>
                    <Td><Badge tone="neutral">{log.action}</Badge></Td>
                    <Td>{log.actorName}</Td>
                    <Td>{log.description}</Td>
                    <Td>
                      <pre className="text-[11px] max-h-24 overflow-auto whitespace-pre-wrap">
                        {JSON.stringify({ ...log.changes, ...log.metadata }, null, 2)}
                      </pre>
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