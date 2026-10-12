'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Input, Select, SelectOption } from '@/components/ui';
import { formatAmount, formatDate } from '@/lib/format';
import { budgetApi, mutationInit } from '../../budget-client-utils';

type Scenario = {
  id: string;
  kind: string;
  name: string;
  description: string | null;
  adjustmentFactor: string;
  createdAt: string;
  projectedActual: string;
  projectedAvailable: string;
};

export default function BudgetScenariosClient({ budgetId, actor }: { budgetId: string; actor: { roleCodes: string[] } }) {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [currency, setCurrency] = useState('TZS');
  const [kind, setKind] = useState('EXPECTED_CASE');
  const [name, setName] = useState('Expected case');
  const [description, setDescription] = useState('');
  const [factor, setFactor] = useState('1.00');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [budget, data] = await Promise.all([
        budgetApi<{ budget: { currencyCode: string } }>(`/api/v1/budgets/${budgetId}`),
        budgetApi<Scenario[]>(`/api/v1/budgets/${budgetId}/scenarios`),
      ]);
      setCurrency(budget.budget.currencyCode);
      setScenarios(data);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load scenarios.');
    }
  }, [budgetId]);
  useEffect(() => { void load(); }, [load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await budgetApi(`/api/v1/budgets/${budgetId}/scenarios`, mutationInit('POST', {
        kind, name, description: description || null, adjustmentFactor: factor,
      }));
      setDescription('');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save scenario.');
    } finally {
      setBusy(false);
    }
  };

  const canCreate = actor.roleCodes.includes('BUDGETS.CREATE');
  return (
    <div className="space-y-5">
      <div><Link href={`/budgets/${budgetId}`} className="text-sm text-muted-foreground hover:underline">← Budget</Link><h1 className="mt-2 text-2xl font-semibold">Budget scenarios</h1><p className="mt-1 text-sm text-muted-foreground">Scenario factors project actual spend and never change the approved budget lines.</p></div>
      {error && <Alert tone="danger" title="Scenario action failed">{error}</Alert>}
      {canCreate && <Card><CardHeader title="Add a projection" description="A factor of 1.10 projects actuals at 110% of the current amount." /><CardBody>
        <form className="grid gap-3 md:grid-cols-2" onSubmit={(event) => void create(event)}>
          <label className="text-sm"><span className="mb-1 block font-medium">Scenario type</span><Select value={kind} onChange={(event) => setKind(event.target.value)}>{['BEST_CASE', 'EXPECTED_CASE', 'WORST_CASE', 'CUSTOM'].map((value) => <SelectOption key={value} value={value}>{value.replaceAll('_', ' ')}</SelectOption>)}</Select></label>
          <label className="text-sm"><span className="mb-1 block font-medium">Name</span><Input required minLength={2} maxLength={200} value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label className="text-sm"><span className="mb-1 block font-medium">Actual spend factor</span><Input required type="number" min="0" step="0.000001" value={factor} onChange={(event) => setFactor(event.target.value)} /></label>
          <label className="text-sm"><span className="mb-1 block font-medium">Description</span><Input maxLength={2000} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          <div className="md:col-span-2"><Button disabled={busy}>Save scenario</Button></div>
        </form>
      </CardBody></Card>}
      <Card><CardHeader title="Saved projections" /><CardBody>
        {scenarios.length === 0 ? <p className="text-sm text-muted-foreground">No scenarios have been saved.</p> : <div className="space-y-3">{scenarios.map((scenario) => <div key={scenario.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4">
          <div><div className="flex items-center gap-2"><h2 className="font-semibold">{scenario.name}</h2><Badge tone="info">{scenario.kind.replaceAll('_', ' ')}</Badge></div><p className="mt-1 text-sm text-muted-foreground">{scenario.description ?? 'No description'} · factor {scenario.adjustmentFactor} · {formatDate(scenario.createdAt)}</p></div>
          <div className="grid grid-cols-2 gap-4 text-sm"><div><div className="text-xs text-muted-foreground">Projected actual</div><div className="font-semibold">{formatAmount(Number(scenario.projectedActual), currency)}</div></div><div><div className="text-xs text-muted-foreground">Projected available</div><div className="font-semibold">{formatAmount(Number(scenario.projectedAvailable), currency)}</div></div></div>
        </div>)}</div>}
      </CardBody></Card>
    </div>
  );
}
