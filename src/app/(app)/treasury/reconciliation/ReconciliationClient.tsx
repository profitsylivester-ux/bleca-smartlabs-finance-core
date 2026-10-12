'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Card,
  CardHeader,
  CardBody,
  Table,
  Th,
  Td,
  Badge,
  EmptyState,
  Alert,
  Select,
  SelectOption,
} from '@/components/ui';
import { formatDate, formatAmount } from '@/lib/format';

/**
 * Reconciliation session list (M8 Task 5).
 *
 * Defaults to the outstanding view because that is the queue a treasury officer
 * actually works from: sessions awaiting confirmation or approval. Signed-off
 * sessions are one filter away rather than the default, so the page answers
 * "what still needs me?" before it answers "what did we do?".
 */

type ReconciliationSession = {
  id: string;
  code: string;
  target: string;
  status: string;
  currency: string;
  statementStartDate: string;
  statementEndDate: string;
  statementClosingBalance: string | null;
  calculatedEndingBalance: string | null;
  difference: string | null;
  autoMatchThreshold: number;
  createdAt: string;
  approvedAt: string | null;
  reopenedAt: string | null;
  treasuryAccount: { id: string; code: string; name: string; kind: string } | null;
  matchCount: number;
  exceptionCount: number;
  adjustmentCount: number;
};

type Actor = {
  roleCodes: string[];
};

const STATUS_TONES: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  NOT_STARTED: 'neutral',
  IN_PROGRESS: 'info',
  MATCHED: 'info',
  AWAITING_APPROVAL: 'warning',
  APPROVED: 'success',
  LOCKED: 'success',
  REOPENED: 'danger',
  CANCELLED: 'neutral',
};
export default function ReconciliationClient({ actor }: { actor: Actor }) {
  const searchParams = useSearchParams();
  const [sessions, setSessions] = useState<ReconciliationSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [status, setStatus] = useState(searchParams.get('status') ?? '');
  const [target, setTarget] = useState(searchParams.get('target') ?? '');
  const [outstandingOnly, setOutstandingOnly] = useState(
    searchParams.get('outstandingOnly') === 'true'
  );

  const canCreate = useMemo(
    () => actor.roleCodes.includes('RECONCILIATION.CREATE'),
    [actor.roleCodes]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (target) params.set('target', target);
    if (outstandingOnly) params.set('outstandingOnly', 'true');

    try {
      const res = await fetch(`/api/v1/reconciliations?${params.toString()}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? 'Failed to load reconciliation sessions.');
        return;
      }
      const body = (await res.json()) as { data: ReconciliationSession[] };
      setSessions(body.data);
    } catch {
      setError('Failed to load reconciliation sessions.');
    } finally {
      setLoading(false);
    }
  }, [status, target, outstandingOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Reconciliation"
          description="Bank, cash, mobile money and gateway reconciliations. Matches require human confirmation before a session can be approved."
          actions={
            canCreate ? (
              <Link
                href="/treasury/reconciliation/new"
                className="rounded-md bg-navy-600 px-3 py-2 text-sm font-medium text-white hover:bg-navy-700"
              >
                New reconciliation
              </Link>
            ) : null
          }
        />
        <CardBody>
          <div className="mb-4 grid gap-3 md:grid-cols-3">
            <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <SelectOption value="">All statuses</SelectOption>
              <SelectOption value="NOT_STARTED">Not started</SelectOption>
              <SelectOption value="IN_PROGRESS">In progress</SelectOption>
              <SelectOption value="AWAITING_APPROVAL">Awaiting approval</SelectOption>
              <SelectOption value="APPROVED">Approved</SelectOption>
              <SelectOption value="LOCKED">Locked</SelectOption>
              <SelectOption value="REOPENED">Reopened</SelectOption>
            </Select>

            <Select aria-label="Target" value={target} onChange={(e) => setTarget(e.target.value)}>
              <SelectOption value="">All targets</SelectOption>
              <SelectOption value="BANK_STATEMENT">Bank statement</SelectOption>
              <SelectOption value="LEDGER">Ledger</SelectOption>
              <SelectOption value="MOBILE_MONEY">Mobile money</SelectOption>
              <SelectOption value="PAYMENT_GATEWAY">Payment gateway</SelectOption>
              <SelectOption value="CASH">Cash</SelectOption>
            </Select>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={outstandingOnly}
                onChange={(e) => setOutstandingOnly(e.target.checked)}
              />
              Outstanding only
            </label>
          </div>

          {error && <Alert tone="danger">{error}</Alert>}

          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : sessions.length === 0 ? (
            <EmptyState
              title="No reconciliation sessions"
              body="Create a session to begin reconciling a treasury account against its statement."
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Code</Th>
                  <Th>Account</Th>
                  <Th>Target</Th>
                  <Th>Period</Th>
                  <Th>Difference</Th>
                  <Th>Matches</Th>
                  <Th>Exceptions</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => {
                  const difference = Number(session.difference ?? 0);
                  return (
                    <tr key={session.id}>
                      <Td>
                        <Link
                          href={`/treasury/reconciliation/${session.id}`}
                          className="font-mono text-navy-600 hover:underline"
                        >
                          {session.code}
                        </Link>
                      </Td>
                      <Td className="text-sm">
                        {session.treasuryAccount
                          ? `${session.treasuryAccount.code} — ${session.treasuryAccount.name}`
                          : '—'}
                      </Td>
                      <Td>
                        <Badge tone="neutral">{session.target.replace(/_/g, ' ')}</Badge>
                      </Td>
                      <Td className="font-mono text-xs">
                        {formatDate(session.statementStartDate)} →{' '}
                        {formatDate(session.statementEndDate)}
                      </Td>
                      <Td className="font-mono tabular-nums text-sm">
                        <Badge tone={difference === 0 ? 'success' : 'warning'}>
                          {formatAmount(difference, session.currency)}
                        </Badge>
                      </Td>
                      <Td className="text-sm">{session.matchCount}</Td>
                      <Td className="text-sm">
                        {session.exceptionCount > 0 ? (
                          <Badge tone="danger">{session.exceptionCount}</Badge>
                        ) : (
                          '0'
                        )}
                      </Td>
                      <Td>
                        <Badge tone={STATUS_TONES[session.status] ?? 'neutral'}>
                          {session.status.replace(/_/g, ' ')}
                        </Badge>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

