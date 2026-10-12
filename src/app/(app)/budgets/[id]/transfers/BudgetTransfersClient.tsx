'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Input, Select, SelectOption } from '@/components/ui';
import { formatAmount, formatDate } from '@/lib/format';
import { budgetApi, mutationInit } from '../../budget-client-utils';

type Line = { lineId: string; accountId: string; account: { code: string; name: string } };
type Transfer = {
  id: string;
  transferNumber: number;
  amount: string;
  reason: string;
  status: string;
  createdAt: string;
  appliedAt: string | null;
  fromLine: { id: string; account: { code: string; name: string } };
  toLine: { id: string; account: { code: string; name: string } };
};

export default function BudgetTransfersClient({ budgetId, actor }: { budgetId: string; actor: { roleCodes: string[] } }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [currency, setCurrency] = useState('TZS');
  const [fromLineId, setFromLineId] = useState('');
  const [toLineId, setToLineId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [budget, history] = await Promise.all([
        budgetApi<{ budget: { currencyCode: string }; lines: Line[] }>(`/api/v1/budgets/${budgetId}`),
        budgetApi<Transfer[]>(`/api/v1/budgets/${budgetId}/transfers`),
      ]);
      setLines(budget.lines);
      setCurrency(budget.budget.currencyCode);
      setTransfers(history);
      setFromLineId((current) => current || budget.lines[0]?.lineId || '');
      setToLineId((current) => current || budget.lines.find((line) => line.lineId !== budget.lines[0]?.lineId)?.lineId || '');
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load transfers.');
    }
  }, [budgetId]);
  useEffect(() => { void load(); }, [load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await budgetApi(`/api/v1/budgets/${budgetId}/transfers`, mutationInit('POST', { fromLineId, toLineId, amount, reason }));
      setAmount('');
      setReason('');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create transfer.');
    } finally {
      setBusy(false);
    }
  };

  const approve = async (transferId: string) => {
    setBusy(true);
    try {
      await budgetApi(`/api/v1/budgets/${budgetId}/transfers/${transferId}/approve`, mutationInit('POST', {}));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not approve transfer.');
    } finally {
      setBusy(false);
    }
  };

  const canCreate = actor.roleCodes.includes('BUDGETS.CREATE');
  const canApprove = actor.roleCodes.includes('BUDGETS.APPROVE');
  return (
    <div className="space-y-5">
      <div><Link href={`/budgets/${budgetId}`} className="text-sm text-muted-foreground hover:underline">← Budget</Link><h1 className="mt-2 text-2xl font-semibold">Budget transfers</h1><p className="mt-1 text-sm text-muted-foreground">Transfers change approved amounts only after a separate approver applies them.</p></div>
      {error && <Alert tone="danger" title="Transfer action failed">{error}</Alert>}
      {canCreate && lines.length > 1 && <Card><CardHeader title="Propose transfer" description="The source line must have enough available funds after actuals and commitments." /><CardBody>
        <form className="grid gap-3 md:grid-cols-2" onSubmit={(event) => void create(event)}>
          <label className="text-sm"><span className="mb-1 block font-medium">From</span><Select value={fromLineId} onChange={(event) => {
            const nextFromLineId = event.target.value;
            setFromLineId(nextFromLineId);
            if (toLineId === nextFromLineId) {
              setToLineId(lines.find((line) => line.lineId !== nextFromLineId)?.lineId ?? '');
            }
          }}>{lines.map((line) => <SelectOption key={line.lineId} value={line.lineId}>{line.account.code} · {line.account.name}</SelectOption>)}</Select></label>
          <label className="text-sm"><span className="mb-1 block font-medium">To</span><Select value={toLineId} onChange={(event) => setToLineId(event.target.value)}>{lines.filter((line) => line.lineId !== fromLineId).map((line) => <SelectOption key={line.lineId} value={line.lineId}>{line.account.code} · {line.account.name}</SelectOption>)}</Select></label>
          <label className="text-sm"><span className="mb-1 block font-medium">Amount ({currency})</span><Input required type="number" min="0.000001" step="0.000001" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
          <label className="text-sm"><span className="mb-1 block font-medium">Reason</span><Input required minLength={3} maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
          <div className="md:col-span-2"><Button disabled={busy || !fromLineId || !toLineId}>Submit transfer</Button></div>
        </form>
      </CardBody></Card>}
      <Card><CardHeader title="Transfer history" /><CardBody>
        {transfers.length === 0 ? <p className="text-sm text-muted-foreground">No transfers have been proposed.</p> : <div className="space-y-3">{transfers.map((transfer) => <div key={transfer.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4">
          <div><div className="font-semibold">Transfer {transfer.transferNumber} · {formatAmount(Number(transfer.amount), currency)}</div><div className="text-sm text-muted-foreground">{transfer.fromLine.account.code} → {transfer.toLine.account.code} · {transfer.reason}</div><div className="text-xs text-muted-foreground">{formatDate(transfer.createdAt)}{transfer.appliedAt ? ` · applied ${formatDate(transfer.appliedAt)}` : ''}</div></div>
          <div className="flex items-center gap-2"><Badge tone={transfer.status === 'APPROVED' ? 'success' : 'warning'}>{transfer.status}</Badge>{transfer.status === 'DRAFT' && canApprove && <Button size="sm" disabled={busy} onClick={() => void approve(transfer.id)}>Approve</Button>}</div>
        </div>)}</div>}
      </CardBody></Card>
    </div>
  );
}
