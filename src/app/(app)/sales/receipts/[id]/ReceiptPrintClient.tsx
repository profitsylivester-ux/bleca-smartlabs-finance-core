'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui';
import { salesRequest } from '../../sales-client';

interface ReceiptData {
  number: string;
  status: string;
  issuedAt: string;
  amount: string;
  currencyCode: string;
  payment: { number: string; customer?: { party?: { displayName?: string; code?: string } } | null; methods: Array<{ method: string; amount: string; reference: string | null }> };
  lines: Array<{ id: string; amount: string; invoice?: { number: string } | null }>;
}

export default function ReceiptPrintClient({ id }: { id: string }) {
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void salesRequest<ReceiptData>(`/api/v1/receipts/${id}`).then(setReceipt).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not load receipt.')); }, [id]);
  if (error) return <p className="text-danger-700">{error}</p>;
  if (!receipt) return <p>Loading receipt…</p>;
  return <article className="mx-auto max-w-2xl rounded-lg border border-border bg-white p-8 print:border-0 print:p-0">
    <div className="mb-8 flex items-start justify-between"><div><p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">BLECA SmartLabs</p><h1 className="mt-2 text-3xl font-semibold">Receipt</h1></div><div className="text-right"><p className="font-semibold">{receipt.number}</p><p className="text-sm text-muted-foreground">Issued {new Date(receipt.issuedAt).toLocaleDateString()}</p><p className="text-sm">{receipt.status}</p></div></div>
    <dl className="grid grid-cols-2 gap-y-3 border-y border-border py-5 text-sm"><dt className="text-muted-foreground">Received from</dt><dd>{receipt.payment.customer?.party?.displayName ?? receipt.payment.customer?.party?.code ?? 'Customer'}</dd><dt className="text-muted-foreground">Payment</dt><dd>{receipt.payment.number}</dd><dt className="text-muted-foreground">Amount received</dt><dd className="font-semibold">{receipt.currencyCode} {receipt.amount}</dd></dl>
    <h2 className="mt-6 font-medium">Applied invoices</h2><div className="mt-2 divide-y divide-border">{receipt.lines.map((line) => <div key={line.id} className="flex justify-between py-2 text-sm"><span>{line.invoice?.number ?? 'On-account credit'}</span><span>{receipt.currencyCode} {line.amount}</span></div>)}</div>
    <h2 className="mt-6 font-medium">Payment methods</h2><div className="mt-2 divide-y divide-border">{receipt.payment.methods.map((method, index) => <div key={`${method.method}-${index}`} className="flex justify-between py-2 text-sm"><span>{method.method.replaceAll('_', ' ')}{method.reference ? ` · ${method.reference}` : ''}</span><span>{receipt.currencyCode} {method.amount}</span></div>)}</div>
    <p className="mt-8 text-xs text-muted-foreground">This receipt confirms the payment shown above. Keep it for your records.</p>
    <Button className="mt-6 print:hidden" onClick={() => window.print()}>Print receipt</Button>
  </article>;
}
