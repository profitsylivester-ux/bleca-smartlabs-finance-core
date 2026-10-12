'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState, Input, Select, SelectOption, Table, Td, Th } from '@/components/ui';

type ObligationRow = {
  id: string; period: string; direction: string; status: string;
  filingDueDate: string | null; taxableAmount: string; taxAmount: string; currencyCode: string;
  taxRule: { code: string; name: string } | null;
};

const STATUSES = ['PENDING', 'FILED', 'PAID', 'OVERDUE', 'EXEMPT', 'NOT_APPLICABLE'];
const DIRECTIONS = ['OUTPUT', 'INPUT', 'WITHHELD', 'PAYABLE'];

export default function ObligationsClient() {
  const [rows, setRows] = useState<ObligationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [period, setPeriod] = useState('');
  const [direction, setDirection] = useState('OUTPUT');
  const [taxable, setTaxable] = useState('');
  const [tax, setTax] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    try {
      const response = await fetch(`/api/v1/tax-obligations?${params.toString()}`);
      const result = await response.json() as { data?: ObligationRow[]; error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? 'Could not load obligations.');
      setRows(result.data ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load obligations.');
    } finally { setLoading(false); }
  }, [status]);
  useEffect(() => { void load(); }, [load]);


  async function createObligation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(null); setNotice(null);
    try {
      const response = await fetch('/api/v1/tax-obligations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({
          period: period.trim(), direction, taxableAmount: taxable.trim(),
          taxAmount: tax.trim(), currencyCode: 'TZS',
        }),
      });
      const result = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? 'Could not create obligation.');
      setPeriod(''); setTaxable(''); setTax('');
      setNotice('Obligation recorded.');
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create obligation.'); }
    finally { setSaving(false); }
  }

  async function act(id: string, action: 'file' | 'mark-paid') {
    setError(null); setNotice(null);
    try {
      const response = await fetch(`/api/v1/tax-obligations/${id}/${action}`, {
        method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() },
      });
      const result = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? 'Action failed.');
      setNotice(action === 'file' ? 'Obligation filed.' : 'Obligation marked paid.');
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Action failed.'); }
  }

  return <div className="space-y-5">
    {error && <Alert tone="danger" title="Obligation request failed">{error}</Alert>}
    {notice && <Alert tone="success">{notice}</Alert>}
    <Card><CardHeader title="Tax obligations" description="Filing deadlines and payment status per period." /><CardBody>
      <form onSubmit={(event) => void createObligation(event)} className="mb-5 grid gap-3 rounded-lg border border-border p-4 md:grid-cols-[1fr_1fr_1fr_1fr_auto]">
        <Input aria-label="Period" placeholder="Period (e.g. 2026-09)" value={period} onChange={(event) => setPeriod(event.target.value)} required />
        <Select aria-label="Direction" value={direction} onChange={(event) => setDirection(event.target.value)}>{DIRECTIONS.map((value) => <SelectOption key={value} value={value}>{value}</SelectOption>)}</Select>
        <Input aria-label="Taxable amount" placeholder="Taxable" value={taxable} onChange={(event) => setTaxable(event.target.value)} required inputMode="decimal" />
        <Input aria-label="Tax amount" placeholder="Tax" value={tax} onChange={(event) => setTax(event.target.value)} required inputMode="decimal" />
        <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'New obligation'}</Button>
      </form>
      <div className="mb-4 flex gap-3"><Select aria-label="Filter status" value={status} onChange={(event) => setStatus(event.target.value)}><SelectOption value="">All statuses</SelectOption>{STATUSES.map((value) => <SelectOption key={value} value={value}>{value}</SelectOption>)}</Select></div>
      {loading ? <p className="py-8 text-center text-sm text-muted-foreground">Loading obligations…</p> : rows.length === 0 ? <EmptyState title="No obligations found" body="Record the first obligation for the current period." /> : <Table><thead><tr><Th>Period</Th><Th>Rule</Th><Th>Amounts</Th><Th>Due</Th><Th>Status</Th><Th>Actions</Th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}>
        <Td><span className="font-medium">{row.period}</span><div className="text-xs text-muted-foreground">{row.direction}</div></Td>
        <Td>{row.taxRule ? row.taxRule.code : '—'}</Td>
        <Td>{row.currencyCode} {row.taxAmount}<div className="text-xs text-muted-foreground">on {row.taxableAmount}</div></Td>
        <Td>{row.filingDueDate?.slice(0, 10) ?? '—'}</Td>
        <Td><Badge tone={row.status === 'PAID' ? 'success' : row.status === 'OVERDUE' ? 'danger' : row.status === 'FILED' ? 'info' : 'neutral'}>{row.status}</Badge></Td>
        <Td><div className="flex gap-2">{row.status === 'PENDING' && <Button size="sm" variant="outline" onClick={() => void act(row.id, 'file')}>File</Button>}{row.status === 'FILED' && <Button size="sm" variant="outline" onClick={() => void act(row.id, 'mark-paid')}>Mark paid</Button>}</div></Td>
      </tr>)}</tbody></Table>}
    </CardBody></Card>
  </div>;
}
