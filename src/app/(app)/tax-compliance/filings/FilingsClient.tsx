'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, CardBody, CardHeader, EmptyState, Input, Table, Td, Th } from '@/components/ui';

type PaymentRow = {
  id: string; paidAt: string; amount: string; currencyCode: string;
  reference: string | null; obligationId: string | null;
};

export default function FilingsClient() {
  const [rows, setRows] = useState<PaymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [obligationId, setObligationId] = useState('');
  const [amount, setAmount] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const response = await fetch('/api/v1/tax-payments');
      const result = await response.json() as { data?: PaymentRow[]; error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? 'Could not load payments.');
      setRows(result.data ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load payments.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function createPayment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(null); setNotice(null);
    try {
      const response = await fetch('/api/v1/tax-payments', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({
          obligationId: obligationId.trim(),
          paidAt: new Date().toISOString().slice(0, 10),
          amount: amount.trim(), currencyCode: 'TZS',
        }),
      });
      const result = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? 'Could not record payment.');
      setObligationId(''); setAmount('');
      setNotice('Payment recorded and obligation marked paid.');
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not record payment.'); }
    finally { setSaving(false); }
  }

  return <div className="space-y-5">
    {error && <Alert tone="danger" title="Filing request failed">{error}</Alert>}
    {notice && <Alert tone="success">{notice}</Alert>}
    <Card><CardHeader title="Filings and payments" description="Payments are linked to obligations; full cover marks the obligation paid."  /><CardBody>
      <form onSubmit={(event) => void createPayment(event)} className="mb-5 grid gap-3 rounded-lg border border-border p-4 md:grid-cols-[2fr_1fr_auto]">
        <Input aria-label="Obligation ID" placeholder="Obligation ID" value={obligationId} onChange={(event) => setObligationId(event.target.value)} required />
        <Input aria-label="Amount" placeholder="Amount" value={amount} onChange={(event) => setAmount(event.target.value)} required inputMode="decimal" />
        <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Record payment'}</Button>
      </form>
      {loading ? <p className="py-8 text-center text-sm text-muted-foreground">Loading payments…</p> : rows.length === 0 ? <EmptyState title="No payments recorded" body="Record a payment against a filed obligation." /> : <Table><thead><tr><Th>Paid</Th><Th>Amount</Th><Th>Reference</Th><Th>Obligation</Th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}>
        <Td>{row.paidAt.slice(0, 10)}</Td>
        <Td className="font-medium">{row.currencyCode} {row.amount}</Td>
        <Td>{row.reference ?? '—'}</Td>
        <Td className="font-mono text-xs">{row.obligationId?.slice(0, 8) ?? '—'}</Td>
      </tr>)}</tbody></Table>}
    </CardBody></Card>
  </div>;
}
