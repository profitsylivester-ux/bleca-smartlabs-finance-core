'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  Card,
  CardHeader,
  CardBody,
  Badge,
  Button,
  EmptyState,
  Alert,
} from '@/components/ui';
import { formatAmount } from '@/lib/format';

/**
 * Reconciliation workbench (M8 Task 5, PDF §12).
 *
 * The one thing this screen must never do is imply the engine confirmed
 * anything. Proposed matches are shown with an explicit Confirm button per row
 * and a status badge that says PROPOSED, and the approve action is disabled with
 * a stated reason until every gate is actually satisfied. A treasury officer
 * looking at this page should be able to tell, without reading code, which
 * pairings a machine guessed and which a human vouched for.
 */

type Match = {
  id: string;
  matchType: string;
  status: string;
  statementAmount: string;
  ledgerAmount: string;
  matchedAmount: string;
  differenceAmount: string;
  confidence: number | null;
  isManual: boolean;
  matchedAt: string | null;
  confirmedAt: string | null;
  confirmedById: string | null;
  rejectionReason: string | null;
  importRowId: string | null;
  transactionId: string | null;
  journalEntryId: string | null;
};

type Exception = {
  id: string;
  exceptionType: string;
  severity: string;
  amount: string;
  description: string;
  suggestedResolution: string | null;
  status: string;
  resolution: string | null;
  resolvedAt: string | null;
  importRowId: string | null;
  transactionId: string | null;
};

type Adjustment = {
  id: string;
  description: string;
  debit: string;
  credit: string;
  currency: string;
  status: string;
  journalEntryId: string | null;
  postedAt: string | null;
};

type Totals = {
  difference: string;
  calculatedEndingBalance: string | null;
  proposedCount: number;
  matchedCount: number;
  unresolvedExceptionCount: number;
  unconfirmedCount: number;
};

type Session = {
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
  reopenReason: string | null;
  reopenCount: number;
  notes: string | null;
  treasuryAccount: {
    id: string;
    code: string;
    name: string;
    kind: string;
    ledgerAccountId: string;
  } | null;
  matches: Match[];
  exceptions: Exception[];
  adjustments: Adjustment[];
};

type Actor = {
  roleCodes: string[];
};

const MATCH_STATUS_TONES: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  PROPOSED: 'warning',
  MATCHED: 'success',
  REJECTED: 'danger',
  EXCEPTION: 'danger',
  RESOLVED: 'success',
};
export default function WorkbenchClient({
  sessionId,
  actor,
}: {
  sessionId: string;
  actor: Actor;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reopenReason, setReopenReason] = useState('');

  const canConfirm = actor.roleCodes.includes('RECONCILIATION.APPROVE');
  const canEdit = actor.roleCodes.includes('RECONCILIATION.EDIT');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/reconciliations/${sessionId}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? 'Failed to load reconciliation session.');
        return;
      }
      const body = (await res.json()) as { data: { session: Session; totals: Totals } };
      setSession(body.data.session);
      setTotals(body.data.totals);
    } catch {
      setError('Failed to load reconciliation session.');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const post = useCallback(
    async (path: string, body: unknown, busyKey: string) => {
      setBusy(busyKey);
      setError(null);
      setNotice(null);
      try {
        const res = await fetch(path, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': crypto.randomUUID(),
          },
          body: JSON.stringify(body ?? {}),
        });

        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          setError(payload?.error?.message ?? 'The action was rejected.');
          return;
        }

        setNotice('Done.');
        await load();
      } catch {
        setError('The action could not be completed.');
      } finally {
        setBusy(null);
      }
    },
    [load]
  );

  const confirmMatch = (matchId: string) =>
    post(`/api/v1/matches/${matchId}/confirm`, {}, `confirm-${matchId}`);

  const runAutoMatch = () =>
    post(`/api/v1/reconciliations/${sessionId}/auto-match`, {}, 'auto-match');

  const approve = () => post(`/api/v1/reconciliations/${sessionId}/approve`, {}, 'approve');

  const reopen = () =>
    post(`/api/v1/reconciliations/${sessionId}/reopen`, { reason: reopenReason }, 'reopen');

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading reconciliation…</p>;
  }

  if (error && !session) {
    return <Alert tone="danger">{error}</Alert>;
  }

  if (!session || !totals) {
    return <EmptyState title="Session not found" body="This reconciliation session is unavailable." />;
  }

  const difference = Number(totals.difference);
  const isLocked = session.status === 'LOCKED' || session.status === 'APPROVED';

  /**
   * The approval gate, mirrored in the UI.
   *
   * These are the same four conditions the service enforces, surfaced here so a
   * user is told *why* the button is disabled rather than discovering it through
   * a rejected request. The service remains the authority — this is a courtesy,
   * never the control.
   */
  const approvalBlockers: string[] = [];
  if (difference !== 0) {
    approvalBlockers.push(
      `Difference must be zero (currently ${formatAmount(difference, session.currency)}).`
    );
  }
  if (totals.unconfirmedCount > 0) {
    approvalBlockers.push(`${totals.unconfirmedCount} match(es) still need human confirmation.`);
  }
  if (totals.unresolvedExceptionCount > 0) {
    approvalBlockers.push(`${totals.unresolvedExceptionCount} exception(s) are still open.`);
  }
  const unpostedAdjustments = session.adjustments.filter(
    (a) => a.status === 'DRAFT' || a.status === 'SUBMITTED'
  );
  if (unpostedAdjustments.length > 0) {
    approvalBlockers.push(`${unpostedAdjustments.length} adjustment(s) are not yet posted.`);
  }

  return (
    <div className="space-y-6">
      {error && <Alert tone="danger">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <Card>
        <CardHeader
          title={`${session.code} — ${session.target.replace(/_/g, ' ')}`}
          description={`${session.treasuryAccount ? `${session.treasuryAccount.code} — ${session.treasuryAccount.name}` : 'No account'} · threshold ${session.autoMatchThreshold}`}
        />
        <CardBody>
          <div className="grid gap-4 md:grid-cols-4">
            <div>
              <p className="text-xs uppercase text-muted-foreground">Status</p>
              <Badge tone={MATCH_STATUS_TONES[session.status] ?? 'neutral'}>
                {session.status.replace(/_/g, ' ')}
              </Badge>
            </div>
            <div>
              <p className="text-xs uppercase text-muted-foreground">Statement closing</p>
              <p className="font-mono tabular-nums">
                {session.statementClosingBalance
                  ? formatAmount(Number(session.statementClosingBalance), session.currency)
                  : '—'}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase text-muted-foreground">Calculated ending</p>
              <p className="font-mono tabular-nums">
                {totals.calculatedEndingBalance
                  ? formatAmount(Number(totals.calculatedEndingBalance), session.currency)
                  : '—'}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase text-muted-foreground">Difference</p>
              <p className="font-mono tabular-nums">
                <Badge tone={difference === 0 ? 'success' : 'warning'}>
                  {formatAmount(difference, session.currency)}
                </Badge>
              </p>
            </div>
          </div>

          {session.reopenReason && (
            <p className="mt-4 text-sm">
              <span className="font-medium">Reopened:</span> {session.reopenReason}
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            {canEdit && !isLocked && (
              <Button onClick={runAutoMatch} disabled={busy !== null}>
                {busy === 'auto-match' ? 'Matching…' : 'Run auto-match'}
              </Button>
            )}
            {canConfirm && !isLocked && (
              <Button onClick={approve} disabled={busy !== null || approvalBlockers.length > 0}>
                {busy === 'approve' ? 'Approving…' : 'Approve & lock'}
              </Button>
            )}
          </div>

          {!isLocked && approvalBlockers.length > 0 && (
            <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3">
              <p className="text-sm font-medium">Approval is blocked:</p>
              <ul className="mt-1 list-inside list-disc text-sm">
                {approvalBlockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Matches"
          description="Proposed matches are machine suggestions and require confirmation before they count."
        />
        <CardBody>
          {session.matches.length === 0 ? (
            <EmptyState
              title="No matches yet"
              body="Run auto-match to generate proposals, or wait for a manual pairing."
            />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2">Type</th>
                  <th className="py-2">Statement</th>
                  <th className="py-2">Ledger</th>
                  <th className="py-2">Difference</th>
                  <th className="py-2">Confidence</th>
                  <th className="py-2">Status</th>
                  <th className="py-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {session.matches.map((match) => (
                  <tr key={match.id} className="border-t">
                    <td className="py-2">{match.matchType.replace(/_/g, ' ')}</td>
                    <td className="py-2 font-mono tabular-nums">
                      {formatAmount(Number(match.statementAmount), session.currency)}
                    </td>
                    <td className="py-2 font-mono tabular-nums">
                      {formatAmount(Number(match.ledgerAmount), session.currency)}
                    </td>
                    <td className="py-2 font-mono tabular-nums">
                      {formatAmount(Number(match.differenceAmount), session.currency)}
                    </td>
                    <td className="py-2">
                      {match.confidence === null ? '—' : `${match.confidence}%`}
                    </td>
                    <td className="py-2">
                      <Badge tone={MATCH_STATUS_TONES[match.status] ?? 'neutral'}>
                        {match.status}
                      </Badge>
                    </td>
                    <td className="py-2">
                      {match.status === 'PROPOSED' ? (
                        canConfirm && !isLocked ? (
                          <Button
                            size="sm"
                            onClick={() => confirmMatch(match.id)}
                            disabled={busy !== null}
                          >
                            {busy === `confirm-${match.id}` ? 'Confirming…' : 'Confirm'}
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">Awaiting confirmation</span>
                        )
                      ) : match.confirmedAt ? (
                        <span className="text-xs text-muted-foreground">
                          Confirmed {new Date(match.confirmedAt).toLocaleDateString()}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Exceptions"
          description="Items the engine could not pair. Open exceptions block approval."
        />
        <CardBody>
          {session.exceptions.length === 0 ? (
            <EmptyState
              title="No exceptions"
              body="Every statement line and book entry was paired."
            />
          ) : (
            <ul className="divide-y">
              {session.exceptions.map((exception) => (
                <li key={exception.id} className="py-3">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium">
                        {exception.exceptionType.replace(/_/g, ' ')}
                      </p>
                      <p className="text-sm text-muted-foreground">{exception.description}</p>
                      {exception.suggestedResolution && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Suggested: {exception.suggestedResolution}
                        </p>
                      )}
                    </div>
                    <div className="text-right">
                      <p className="font-mono text-sm tabular-nums">
                        {formatAmount(Number(exception.amount), session.currency)}
                      </p>
                      <Badge tone={exception.status === 'OPEN' ? 'danger' : 'success'}>
                        {exception.status}
                      </Badge>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Adjustments" description="Corrections raised against this session." />
        <CardBody>
          {session.adjustments.length === 0 ? (
            <EmptyState title="No adjustments" body="No corrections have been raised." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2">Description</th>
                  <th className="py-2">Debit</th>
                  <th className="py-2">Credit</th>
                  <th className="py-2">Journal entry</th>
                  <th className="py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {session.adjustments.map((adjustment) => (
                  <tr key={adjustment.id} className="border-t">
                    <td className="py-2">{adjustment.description}</td>
                    <td className="py-2 font-mono tabular-nums">
                      {formatAmount(Number(adjustment.debit), adjustment.currency)}
                    </td>
                    <td className="py-2 font-mono tabular-nums">
                      {formatAmount(Number(adjustment.credit), adjustment.currency)}
                    </td>
                    <td className="py-2 font-mono text-xs">
                      {adjustment.journalEntryId ? (
                        <Link
                          href={`/accounting/journal-entries/${adjustment.journalEntryId}`}
                          className="text-navy-600 hover:underline"
                        >
                          {adjustment.journalEntryId.slice(0, 8)}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="py-2">
                      <Badge tone={adjustment.status === 'POSTED' ? 'success' : 'warning'}>
                        {adjustment.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      {isLocked && (
        <Card>
          <CardHeader
            title="Reopen"
            description="Requires a reason. Reopening puts the session back under review."
          />
          <CardBody>
            <div className="flex flex-col gap-2 md:flex-row">
              <input
                className="flex-1 rounded-md border px-3 py-2 text-sm"
                placeholder="Why is this being reopened?"
                value={reopenReason}
                onChange={(e) => setReopenReason(e.target.value)}
              />
              <Button onClick={reopen} disabled={busy !== null || reopenReason.trim().length < 10}>
                {busy === 'reopen' ? 'Reopening…' : 'Reopen session'}
              </Button>
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

