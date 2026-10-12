'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Table, Td, Th } from '@/components/ui';
import { formatAmount, formatDate } from '@/lib/format';
import { budgetApi, mutationInit } from '../budget-client-utils';

type BudgetView = {
  budget: {
    id: string;
    code: string;
    name: string;
    status: string;
    type: string;
    periodType: string;
    startDate: string;
    endDate: string;
    currencyCode: string;
    approved: string;
    committed: string;
    actual: string;
    available: string;
    isOverBudget: boolean;
  };
  lines: Array<{
    accountId: string;
    account: { code: string; name: string; type: string };
    approved: string;
    committed: string;
    actual: string;
    available: string;
    isOverBudget: boolean;
    percentSpent: number;
  }>;
  warnings: string[];
};

export default function BudgetDetailClient({ budgetId, actor }: { budgetId: string; actor: { roleCodes: string[] } }) {
  const [view, setView] = useState<BudgetView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setView(await budgetApi<BudgetView>(`/api/v1/budgets/${budgetId}`));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load budget.');
    } finally {
      setLoading(false);
    }
  }, [budgetId]);
  useEffect(() => { void load(); }, [load]);

  const transition = async (action: 'submit' | 'approve' | 'activate' | 'close') => {
    setBusy(true);
    try {
      await budgetApi(`/api/v1/budgets/${budgetId}/${action}`, mutationInit('POST', {}));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not ${action} budget.`);
    } finally {
      setBusy(false);
    }
  };

  if (loading && !view) return <p className="text-sm text-muted-foreground">Loading budget…</p>;
  if (!view) return <Alert tone="danger" title="Budget unavailable">{error ?? 'The budget could not be loaded.'}</Alert>;
  const { budget, lines, warnings } = view;
  const canSubmit = actor.roleCodes.includes('BUDGETS.SUBMIT');
  const canApprove = actor.roleCodes.includes('BUDGETS.APPROVE');

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/budgets" className="text-sm text-muted-foreground hover:underline">← Budgets</Link>
          <h1 className="mt-2 text-2xl font-semibold">{budget.code} · {budget.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{budget.type} · {formatDate(budget.startDate)} – {formatDate(budget.endDate)} · {budget.periodType}</p>
        </div>
        <Badge tone={budget.status === 'ACTIVE' ? 'success' : budget.status === 'SUBMITTED' ? 'warning' : 'neutral'}>{budget.status}</Badge>
      </div>

      {error && <Alert tone="danger" title="Budget action failed">{error}</Alert>}
      {warnings.length > 0 && <Alert tone={budget.isOverBudget ? 'danger' : 'warning'} title="Budget warnings"><ul className="list-disc space-y-1 pl-5">{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></Alert>}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[['Approved', budget.approved], ['Committed', budget.committed], ['Actual', budget.actual], ['Available', budget.available]].map(([label, amount]) => (
          <Card key={label}><CardBody><div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div><div className={`mt-1 text-xl font-semibold ${label === 'Available' && budget.isOverBudget ? 'text-danger-700' : ''}`}>{formatAmount(Number(amount), budget.currencyCode)}</div></CardBody></Card>
        ))}
      </div>

      <Card>
        <CardHeader
          title="Budget lines"
          description="Available is recomputed from approved amounts, open commitments, and posted journal entries."
          actions={<div className="flex flex-wrap gap-2"><Link className="text-sm text-navy-700 hover:underline" href={`/budgets/${budgetId}/revisions`}>Revisions</Link><Link className="text-sm text-navy-700 hover:underline" href={`/budgets/${budgetId}/transfers`}>Transfers</Link><Link className="text-sm text-navy-700 hover:underline" href={`/budgets/${budgetId}/scenarios`}>Scenarios</Link></div>}
        />
        <CardBody>
          <div className="mb-4 flex flex-wrap gap-2">
            {budget.status === 'DRAFT' && canSubmit && <Button disabled={busy} onClick={() => void transition('submit')}>Submit for approval</Button>}
            {budget.status === 'SUBMITTED' && canApprove && <Button disabled={busy} onClick={() => void transition('approve')}>Approve budget</Button>}
            {budget.status === 'APPROVED' && canApprove && <Button disabled={busy} onClick={() => void transition('activate')}>Activate budget</Button>}
            {budget.status === 'ACTIVE' && canApprove && <Button disabled={busy} onClick={() => void transition('close')}>Close budget</Button>}
          </div>
          {lines.length === 0 ? <p className="text-sm text-muted-foreground">No budget lines.</p> : (
            <Table>
              <thead><tr><Th>Account</Th><Th>Approved</Th><Th>Committed</Th><Th>Actual</Th><Th>Available</Th><Th>Spent</Th></tr></thead>
              <tbody>{lines.map((line) => <tr key={line.accountId}>
                <Td><span className="font-medium">{line.account.code}</span><div className="text-xs text-muted-foreground">{line.account.name}</div></Td>
                <Td>{formatAmount(Number(line.approved), budget.currencyCode)}</Td>
                <Td>{formatAmount(Number(line.committed), budget.currencyCode)}</Td>
                <Td>{formatAmount(Number(line.actual), budget.currencyCode)}</Td>
                <Td><span className={line.isOverBudget ? 'font-semibold text-danger-700' : ''}>{formatAmount(Number(line.available), budget.currencyCode)}</span></Td>
                <Td>{line.percentSpent.toFixed(1)}%</Td>
              </tr>)}</tbody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
