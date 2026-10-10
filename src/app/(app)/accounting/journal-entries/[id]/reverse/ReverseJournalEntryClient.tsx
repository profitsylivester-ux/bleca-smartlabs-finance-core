'use client';

/* eslint-disable react-hooks/set-state-in-effect */
import { useState, useEffect } from 'react';
import { Card, CardHeader, CardBody, Button, Label, Alert, Badge, Table, Th, Td } from '@/components/ui';
import { formatAmount, formatDate } from '@/lib/format';
import { useRouter } from 'next/navigation';

type ReversalReason = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: string;
};

type JournalEntry = {
  id: string;
  number: string | null;
  type: string;
  status: string;
  reference: string | null;
  description: string | null;
  postedAt: string | null;
  period: { id: string; code: string; name: string } | null;
  lines: Array<{
    id: string;
    accountId: string;
    lineNumber: number;
    description: string | null;
    debit: number | string;
    credit: number | string;
    currencyCode: string;
    projectId: string | null;
    departmentId: string | null;
    costCentreId: string | null;
    locationId: string | null;
    fundingSourceId: string | null;
    account: { id: string; code: string; name: string } | null;
  }>;
};

export default function ReverseJournalEntryClient({ entryId }: { entryId: string }) {
  const router = useRouter();
  const [entry, setEntry] = useState<JournalEntry | null>(null);
  const [reasons, setReasons] = useState<ReversalReason[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    reversalReasonId: '',
    full: true,
    amount: '',
  });

  const fetchData = async () => {
    setLoading(true);
    try {
      const [entryRes, reasonsRes] = await Promise.all([
        fetch(`/api/v1/journal-entries/${entryId}`).then(r => r.json()),
        fetch('/api/v1/reversal-reasons?status=ACTIVE').then(r => r.json()),
      ]);
      setEntry(entryRes.data);
      setReasons(reasonsRes.data || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [entryId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.reversalReasonId) {
      setError('Please select a reversal reason');
      return;
    }
    if (!form.full && (!form.amount || parseFloat(form.amount) <= 0)) {
      setError('Partial reversal requires a positive amount');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/v1/journal-entries/${entryId}/reverse`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          reversalReasonId: form.reversalReasonId,
          full: form.full,
          amount: form.full ? undefined : parseFloat(form.amount),
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || 'Failed to reverse journal entry');
      }
      router.push(`/accounting/journal-entries/${entryId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reverse journal entry');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardBody className="py-12">
          <div className="text-center text-muted-foreground">Loading…</div>
        </CardBody>
      </Card>
    );
  }

  if (error && !entry) {
    return <Alert tone="danger" title="Failed to load journal entry">{error}</Alert>;
  }

  if (!entry) {
    return <Alert tone="danger" title="Not found">Journal entry not found</Alert>;
  }

  if (entry.status !== 'POSTED' && entry.status !== 'LOCKED') {
    return <Alert tone="danger" title="Cannot reverse">Only POSTED or LOCKED entries can be reversed</Alert>;
  }

  const totalDebit = entry.lines.reduce((sum, l) => sum + Number(l.debit), 0);
  const totalCredit = entry.lines.reduce((sum, l) => sum + Number(l.credit), 0);

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Card>
        <CardHeader title="Original Entry" description={`Reversing ${entry.number ?? entry.id}`} />
        <CardBody className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div><span className="text-muted-foreground">Number</span><br />{entry.number ?? shortId(entry.id)}</div>
            <div><span className="text-muted-foreground">Period</span><br />{entry.period?.code ?? '-'}</div>
            <div><span className="text-muted-foreground">Status</span><br /><Badge tone="success">{entry.status}</Badge></div>
            <div><span className="text-muted-foreground">Posted</span><br />{entry.postedAt ? formatDate(entry.postedAt) : '-'}</div>
          </div>
          <div className="border-t pt-2">
            <h3 className="text-sm font-semibold mb-2">Lines to be reversed</h3>
            <Table>
              <thead>
                <tr>
                  <Th>#</Th>
                  <Th>Account</Th>
                  <Th>Description</Th>
                  <Th className="text-right">Original Debit</Th>
                  <Th className="text-right">Original Credit</Th>
                  <Th className="text-right">Reversal Debit</Th>
                  <Th className="text-right">Reversal Credit</Th>
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
                    <Td className="text-right font-mono">
                      {form.full ? formatAmount(Number(line.credit), line.currencyCode) : formatAmount(Math.min(Number(line.credit), parseFloat(form.amount) || 0), line.currencyCode)}
                    </Td>
                    <Td className="text-right font-mono">
                      {form.full ? formatAmount(Number(line.debit), line.currencyCode) : formatAmount(Math.min(Number(line.debit), parseFloat(form.amount) || 0), line.currencyCode)}
                    </Td>
                  </tr>
                ))}
                <tr className="font-semibold bg-surface-muted">
                  <Td colSpan={3} className="text-right">Totals</Td>
                  <Td className="text-right font-mono">{formatAmount(totalDebit)}</Td>
                  <Td className="text-right font-mono">{formatAmount(totalCredit)}</Td>
                  <Td className="text-right font-mono">
                    {form.full ? formatAmount(totalCredit) : formatAmount(Math.min(totalCredit, parseFloat(form.amount) || 0))}
                  </Td>
                  <Td className="text-right font-mono">
                    {form.full ? formatAmount(totalDebit) : formatAmount(Math.min(totalDebit, parseFloat(form.amount) || 0))}
                  </Td>
                </tr>
              </tbody>
            </Table>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Reversal Details" />
        <CardBody className="space-y-4">
          {error && <Alert tone="danger" title="Error">{error}</Alert>}

          <div>
            <Label htmlFor="reversalReasonId">Reversal Reason *</Label>
            <select
              id="reversalReasonId"
              className="border-border-strong text-foreground h-9 w-full rounded-md border bg-white px-3 text-sm"
              value={form.reversalReasonId}
              onChange={(e) => setForm({ ...form, reversalReasonId: e.target.value })}
              required
            >
              <option value="">Select reason</option>
              {reasons.map(r => (
                <option key={r.id} value={r.id}>{r.code} - {r.name} ({r.category})</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="reversalType"
                value="full"
                checked={form.full}
                onChange={() => setForm({ ...form, full: true })}
                className="h-4 w-4"
              />
              <span>Full reversal (entire entry)</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="reversalType"
                value="partial"
                checked={!form.full}
                onChange={() => setForm({ ...form, full: false })}
                className="h-4 w-4"
              />
              <span>Partial reversal</span>
            </label>
          </div>

          {!form.full && (
            <div>
              <Label htmlFor="amount">Amount to reverse *</Label>
              <input
                id="amount"
                type="number"
                step="0.01"
                min="0.01"
                max={Math.max(totalDebit, totalCredit)}
                className="border-border-strong text-foreground h-9 w-full rounded-md border bg-white px-3 text-sm"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                required
              />
              <p className="text-xs text-muted-foreground mt-1">Maximum: {formatAmount(Math.max(totalDebit, totalCredit))}</p>
            </div>
          )}
        </CardBody>
      </Card>

      <div className="flex justify-end gap-3">
        <Button variant="ghost" onClick={() => router.back()}>Cancel</Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Reversing…' : 'Create Reversal'}
        </Button>
      </div>
    </form>
  );
}

function shortId(id: string | null | undefined, length = 8): string {
  if (!id) return '-';
  return id.length <= length ? id : `${id.slice(0, length)}...`;
}