'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Input, Table, Td, Th } from '@/components/ui';
import { formatAmount, formatDate } from '@/lib/format';
import { budgetApi, mutationInit } from '../../budget-client-utils';

type BudgetLine = { lineId: string; accountId: string; account: { code: string; name: string }; approved: string };
type Revision = {
  id: string;
  revisionNumber: number;
  reason: string;
  status: string;
  createdAt: string;
  approvedAt: string | null;
  lines: Array<{ budgetLineId: string; account: { code: string; name: string }; beforeAmount: string; afterAmount: string }>;
};

export default function BudgetRevisionsClient({ budgetId, actor }: { budgetId: string; actor: { roleCodes: string[] } }) {
  const [lines, setLines] = useState<BudgetLine[]>([]);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [currency, setCurrency] = useState('TZS');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [budget, history] = await Promise.all([
        budgetApi<{ budget: { currencyCode: string }; lines: BudgetLine[] }>(`/api/v1/budgets/${budgetId}`),
        budgetApi<Revision[]>(`/api/v1/budgets/${budgetId}/revisions`),
      ]);
      setCurrency(budget.budget.currencyCode);
      setLines(budget.lines);
      setRevisions(history);
      setAmounts(Object.fromEntries(budget.lines.map((line) => [line.lineId, line.approved])));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load revisions.');
    }
  }, [budgetId]);
  useEffect(() => { void load(); }, [load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await budgetApi(`/api/v1/budgets/${budgetId}/revisions`, mutationInit('POST', {
        reason,
        changes: lines.map((line) => ({ budgetLineId: line.lineId, afterAmount: amounts[line.lineId] })),
      }));
      setReason('');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create revision.');
    } finally {
      setBusy(false);
    }
  };

  const approve = async (revisionId: string) => {
    setBusy(true);
    try {
      await budgetApi(`/api/v1/budgets/${budgetId}/revisions/${revisionId}/approve`, mutationInit('POST', {}));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not approve revision.');
    } finally {
      setBusy(false);
    }
  };

  const canCreate = actor.roleCodes.includes('BUDGETS.CREATE');
  const canApprove = actor.roleCodes.includes('BUDGETS.APPROVE');
  return (
    <div className="space-y-5">
      <div><Link href={`/budgets/${budgetId}`} className="text-sm text-muted-foreground hover:underline">← Budget</Link><h1 className="mt-2 text-2xl font-semibold">Budget revisions</h1><p className="mt-1 text-sm text-muted-foreground">Each revision records the before and proposed amount. Live lines change only after approval.</p></div>
      {error && <Alert tone="danger" title="Revision action failed">{error}</Alert>}
      {canCreate && lines.length > 0 && <Card><CardHeader title="Propose revision" description="Change one or more approved line amounts and provide a reason." /><CardBody>
        <form className="space-y-4" onSubmit={(event) => void create(event)}>
          <div className="grid gap-3 md:grid-cols-2">{lines.map((line) => <label key={line.lineId} className="text-sm"><span className="mb-1 block font-medium">{line.account.code} · {line.account.name}</span><Input type="number" min="0" step="0.000001" value={amounts[line.lineId] ?? ''} onChange={(event) => setAmounts((previous) => ({ ...previous, [line.lineId]: event.target.value }))} /></label>)}</div>
          <label className="block text-sm"><span className="mb-1 block font-medium">Reason</span><Input required minLength={3} maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
          <Button disabled={busy}>Submit revision for approval</Button>
        </form>
      </CardBody></Card>}
      <Card><CardHeader title="Revision history" /><CardBody>
        {revisions.length === 0 ? <p className="text-sm text-muted-foreground">No revisions have been proposed.</p> : revisions.map((revision) => <div key={revision.id} className="mb-5 rounded-lg border border-border p-4 last:mb-0">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-semibold">Revision {revision.revisionNumber}</h2><p className="text-sm text-muted-foreground">{revision.reason} · {formatDate(revision.createdAt)}</p></div><div className="flex items-center gap-2"><Badge tone={revision.status === 'APPROVED' ? 'success' : 'warning'}>{revision.status}</Badge>{revision.status === 'DRAFT' && canApprove && <Button size="sm" disabled={busy} onClick={() => void approve(revision.id)}>Approve</Button>}</div></div>
          <Table><thead><tr><Th>Account</Th><Th>Before</Th><Th>After</Th></tr></thead><tbody>{revision.lines.map((line) => <tr key={line.budgetLineId}><Td>{line.account.code} · {line.account.name}</Td><Td>{formatAmount(Number(line.beforeAmount), currency)}</Td><Td>{formatAmount(Number(line.afterAmount), currency)}</Td></tr>)}</tbody></Table>
        </div>)}
      </CardBody></Card>
    </div>
  );
}
