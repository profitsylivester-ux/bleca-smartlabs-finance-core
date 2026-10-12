'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState, Table, Td, Th } from '@/components/ui';
import { flattenAccounts, mutationHeaders, salesRequest, type AccountOption } from './sales-client';

export type SalesRegisterKind = 'quotations' | 'invoices' | 'payments' | 'receipts' | 'credit-notes' | 'debit-notes';

interface SalesRow {
  id: string;
  number: string;
  status: string;
  currencyCode?: string;
  totalAmount?: string;
  amount?: string;
  unappliedAmount?: string;
  quoteDate?: string;
  invoiceDate?: string;
  paymentDate?: string;
  issuedAt?: string;
  validUntil?: string;
  dueDate?: string;
  direction?: string;
  recurrenceFrequency?: string | null;
  recurrenceNextAt?: string | null;
  customer?: { party?: { displayName?: string } } | null;
  supplier?: { party?: { displayName?: string } } | null;
  invoice?: { number?: string } | null;
  payment?: { id?: string; customer?: { party?: { displayName?: string } } | null } | null;
  lines?: Array<{ id: string; quantity: string; description: string }>;
}

const config: Record<SalesRegisterKind, { title: string; endpoint: string; newPath: string; description: string }> = {
  quotations: { title: 'Quotations', endpoint: '/api/v1/quotations', newPath: '/sales/quotations/new', description: 'Prepare and track customer quotations. Quotation approval and acceptance do not post revenue.' },
  invoices: { title: 'Invoices', endpoint: '/api/v1/invoices', newPath: '/sales/invoices/new', description: 'Customer receivables and supplier payables, including partial payments and recurring templates.' },
  payments: { title: 'Payments', endpoint: '/api/v1/payments', newPath: '/sales/payments/new', description: 'Record receipts and supplier payments, then allocate them against open invoices.' },
  receipts: { title: 'Receipts', endpoint: '/api/v1/receipts', newPath: '/sales/payments/new', description: 'Print issued receipts or void them with an explanation.' },
  'credit-notes': { title: 'Credit Notes', endpoint: '/api/v1/credit-notes', newPath: '/sales/credit-notes/new', description: 'Credit notes reduce invoice receivables and reverse the related revenue and tax.' },
  'debit-notes': { title: 'Debit Notes', endpoint: '/api/v1/debit-notes', newPath: '/sales/debit-notes/new', description: 'Debit notes adjust an invoice and post through the approval workflow.' },
};

function partyName(row: SalesRow) {
  return row.customer?.party?.displayName ?? row.supplier?.party?.displayName ?? row.payment?.customer?.party?.displayName ?? row.invoice?.number ?? '—';
}

export default function SalesRegister({ kind }: { kind: SalesRegisterKind }) {
  const definition = config[kind];
  const [rows, setRows] = useState<SalesRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revenueAccountId, setRevenueAccountId] = useState('');
  const [revenueAccounts, setRevenueAccounts] = useState<AccountOption[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await salesRequest<SalesRow[]>(definition.endpoint);
      setRows(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load this register.');
    } finally {
      setLoading(false);
    }
  }, [definition.endpoint]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (kind !== 'quotations') return;
    void salesRequest<{ data: AccountOption[] }>('/api/v1/accounts')
      .then((result) => setRevenueAccounts(flattenAccounts(result.data).filter((account) => account.type === 'REVENUE' && account.status === 'ACTIVE' && account.isPostable)))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not load revenue accounts.'));
  }, [kind]);

  async function act(row: SalesRow, action: string, body: Record<string, unknown> = {}) {
    setError(null);
    setNotice(null);
    try {
      await salesRequest(`${definition.endpoint}/${row.id}/${action}`, {
        method: 'POST', headers: mutationHeaders(), body: JSON.stringify(body),
      });
      setNotice(`${row.number} updated.`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The action could not be completed.');
    }
  }

  async function convert(row: SalesRow) {
    if (!revenueAccountId || !row.lines?.length) {
      setError('Choose a revenue account before converting this quotation.');
      return;
    }
    await act(row, 'convert', {
      invoices: [{
        invoiceDate: new Date().toISOString().slice(0, 10),
        dueDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
        lines: row.lines.map((line) => ({ quotationLineId: line.id, quantity: line.quantity, accountId: revenueAccountId })),
      }],
    });
  }

  function actions(row: SalesRow) {
    if (kind === 'quotations') return <div className="flex flex-wrap gap-2">
      {row.status === 'DRAFT' && <Button size="sm" onClick={() => void act(row, 'submit')}>Submit</Button>}
      {row.status === 'APPROVED' && <Button size="sm" onClick={() => void act(row, 'send')}>Mark sent</Button>}
      {row.status === 'SENT' && <Button size="sm" onClick={() => void act(row, 'accept')}>Accept</Button>}
      {row.status === 'ACCEPTED' && <Button size="sm" onClick={() => void convert(row)}>Convert to invoice</Button>}
    </div>;
    if (kind === 'invoices') return <div className="flex flex-wrap gap-2">
      {row.status === 'DRAFT' && <Button size="sm" onClick={() => void act(row, 'submit')}>Submit</Button>}
      {row.status === 'APPROVED' && <Button size="sm" onClick={() => void act(row, 'send')}>Send & post</Button>}
      {['SENT', 'PARTIALLY_PAID', 'OVERDUE'].includes(row.status) && <Button size="sm" variant="outline" onClick={() => { const reason = window.prompt('Cancellation reason (at least five characters):'); if (reason) void act(row, 'cancel', { reason }); }}>Cancel</Button>}
      {row.direction === 'RECEIVABLE' && ['SENT', 'PARTIALLY_PAID', 'OVERDUE'].includes(row.status) && <Button size="sm" variant="outline" onClick={() => void act(row, 'reminders')}>Queue reminder</Button>}
      {row.recurrenceFrequency && row.recurrenceNextAt && <Button size="sm" variant="outline" onClick={() => void act(row, 'recurrences')}>Generate next</Button>}
    </div>;
    if (kind === 'payments') return <div className="flex flex-wrap gap-2">
      {row.status === 'DRAFT' && <Button size="sm" onClick={() => void act(row, 'submit')}>Submit</Button>}
      {row.status === 'APPROVED' && <Button size="sm" onClick={() => void act(row, 'complete')}>Complete & post</Button>}
      {row.status === 'COMPLETED' && <Button size="sm" variant="outline" onClick={() => { const reason = window.prompt('Reason for reversal:'); if (reason) void act(row, 'reverse', { reason }); }}>Reverse</Button>}
    </div>;
    if (kind === 'receipts') return <div className="flex gap-2">
      <Link className="text-sm font-medium text-navy-700 underline" href={`/sales/receipts/${row.id}`}>Print view</Link>
      {row.status === 'ISSUED' && <Button size="sm" variant="outline" onClick={() => { const reason = window.prompt('Reason for voiding this receipt:'); if (reason) void salesRequest(`/api/v1/receipts/${row.id}`, { method: 'DELETE', headers: mutationHeaders(), body: JSON.stringify({ reason }) }).then(load).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not void receipt.')); }}>Void</Button>}
    </div>;
    return row.status === 'DRAFT' ? <Button size="sm" onClick={() => void act(row, 'submit')}>Submit</Button> : null;
  }

  return <div className="space-y-5">
    {error && <Alert tone="danger" title="Sales request failed">{error}</Alert>}
    {notice && <Alert tone="success" title="Saved">{notice}</Alert>}
    <Card>
      <CardHeader title={definition.title} description={definition.description} actions={<Link href={definition.newPath} className="rounded-md bg-navy-800 px-3 py-2 text-sm font-medium text-white hover:bg-navy-700">Create</Link>} />
      <CardBody>
        {kind === 'quotations' && rows.some((row) => row.status === 'ACCEPTED') && <div className="mb-4 flex max-w-xl items-center gap-3 text-sm"><label htmlFor="revenue-account">Revenue account for conversion</label><select id="revenue-account" className="rounded-md border border-border px-2 py-1" value={revenueAccountId} onChange={(event) => setRevenueAccountId(event.target.value)}><option value="">Choose revenue account</option>{revenueAccounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}</select></div>}
        {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : rows.length === 0 ? <EmptyState title={`No ${definition.title.toLowerCase()} yet`} body="Create a document to begin the workflow." /> : <Table>
          <thead><tr><Th>Number</Th><Th>Counterparty / invoice</Th><Th>Date</Th><Th>Due / expiry</Th><Th>Status</Th><Th>Amount</Th><Th>Actions</Th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.id}>
            <Td><span className="font-medium">{row.number}</span>{row.unappliedAmount ? <div className="text-xs text-muted-foreground">On account: {row.unappliedAmount}</div> : null}</Td>
            <Td>{partyName(row)}</Td>
            <Td>{(row.quoteDate ?? row.invoiceDate ?? row.paymentDate ?? row.issuedAt ?? '').slice(0, 10) || '—'}</Td>
            <Td>{(row.validUntil ?? row.dueDate ?? '').slice(0, 10) || '—'}</Td>
            <Td><Badge tone={row.status === 'PAID' || row.status === 'ACCEPTED' || row.status === 'COMPLETED' || row.status === 'ISSUED' ? 'success' : row.status === 'REJECTED' || row.status === 'CANCELLED' || row.status === 'VOIDED' ? 'danger' : 'warning'}>{row.status.replaceAll('_', ' ')}</Badge></Td>
            <Td>{row.currencyCode ?? ''} {row.totalAmount ?? row.amount ?? '—'}</Td>
            <Td>{actions(row)}</Td>
          </tr>)}</tbody>
        </Table>}
      </CardBody>
    </Card>
    {kind === 'quotations' && <Card><CardBody className="text-sm text-muted-foreground">Approval decisions are handled in <Link href="/approvals" className="text-navy-700 underline">Approvals</Link>. The conversion account selector will load eligible revenue accounts from the chart of accounts.</CardBody></Card>}
  </div>;
}
