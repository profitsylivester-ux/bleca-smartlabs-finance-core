'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Card, CardBody, CardHeader, Input, Select, SelectOption } from '@/components/ui';
import { flattenAccounts, mutationHeaders, salesRequest, type AccountOption, type PartyOption, type TreasuryOption } from './sales-client';

type CreateKind = 'quotation' | 'invoice' | 'payment' | 'credit-note' | 'debit-note';
interface InvoiceOption { id: string; number: string; status: string; direction: string; currencyCode: string; customerId: string | null; supplierId: string | null; }

const titles: Record<CreateKind, string> = {
  quotation: 'New quotation', invoice: 'New invoice', payment: 'New payment',
  'credit-note': 'New credit note', 'debit-note': 'New debit note',
};

export default function SalesCreateClient({ kind }: { kind: CreateKind }) {
  const router = useRouter();
  const [customers, setCustomers] = useState<PartyOption[]>([]);
  const [suppliers, setSuppliers] = useState<PartyOption[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [treasury, setTreasury] = useState<TreasuryOption[]>([]);
  const [invoices, setInvoices] = useState<InvoiceOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [direction, setDirection] = useState<'RECEIVABLE' | 'PAYABLE'>('RECEIVABLE');
  const [partyId, setPartyId] = useState('');
  const [invoiceId, setInvoiceId] = useState('');
  const [currencyCode, setCurrencyCode] = useState('TZS');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unitPrice, setUnitPrice] = useState('');
  const [accountId, setAccountId] = useState('');
  const [taxRate, setTaxRate] = useState('');
  const [taxAccountId, setTaxAccountId] = useState('');
  const [treasuryAccountId, setTreasuryAccountId] = useState('');
  const [onAccountAccountId, setOnAccountAccountId] = useState('');
  const [methodLines, setMethodLines] = useState<Array<{ method: string; amount: string }>>([{ method: 'BANK_TRANSFER', amount: '' }]);
  const [manualAllocations, setManualAllocations] = useState<Array<{ invoiceId: string; amount: string }>>([]);
  const [isTaxInvoice, setIsTaxInvoice] = useState(false);
  const [taxInvoiceNumber, setTaxInvoiceNumber] = useState('');
  const [recurrenceFrequency, setRecurrenceFrequency] = useState('');
  const [reasonCode, setReasonCode] = useState('OTHER');
  const [reason, setReason] = useState('');

  useEffect(() => {
    const requests: Promise<void>[] = [];
    if (kind === 'quotation' || kind === 'invoice' || kind === 'payment') {
      requests.push(salesRequest<PartyOption[]>('/api/v1/customers?page=1&pageSize=100').then(setCustomers));
    }
    if (kind === 'invoice' || kind === 'payment') {
      requests.push(salesRequest<PartyOption[]>('/api/v1/suppliers?page=1&pageSize=100').then(setSuppliers));
    }
    if (kind === 'invoice' || kind === 'payment') {
      requests.push(salesRequest<AccountOption[]>('/api/v1/accounts').then((accounts) => setAccounts(flattenAccounts(accounts))));
    }
    if (kind === 'payment') {
      requests.push(salesRequest<TreasuryOption[]>('/api/v1/treasury-accounts').then((rows) => setTreasury(rows.filter((row) => row.isActive))));
    }
    if (kind === 'credit-note' || kind === 'debit-note' || kind === 'payment') {
      requests.push(salesRequest<InvoiceOption[]>('/api/v1/invoices').then(setInvoices));
    }
    void Promise.all(requests).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not load selection lists.'));
  }, [kind]);

  const eligibleParties = useMemo(() => {
    const source = kind === 'invoice' && direction === 'PAYABLE' || kind === 'payment' && direction === 'PAYABLE' ? suppliers : customers;
    return source.filter((party) => party.status === 'ACTIVE' && party.masterDataStatus === 'ACTIVE');
  }, [customers, suppliers, direction, kind]);
  const postableAccounts = useMemo(() => accounts.filter((account) => account.isPostable && account.status === 'ACTIVE'), [accounts]);
  const expectedLineType = direction === 'RECEIVABLE' ? 'REVENUE' : 'EXPENSE';
  const taxType = direction === 'RECEIVABLE' ? 'LIABILITY' : 'ASSET';
  const unappliedType = direction === 'RECEIVABLE' ? 'LIABILITY' : 'ASSET';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      let path = '';
      let body: Record<string, unknown>;
      if (kind === 'quotation') {
        path = '/api/v1/quotations';
        body = {
          customerId: partyId, quoteDate: new Date().toISOString().slice(0, 10),
          validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10), currencyCode,
          lines: [{ description, quantity, unitPrice }],
        };
      } else if (kind === 'invoice') {
        path = '/api/v1/invoices';
        body = {
          direction, ...(direction === 'RECEIVABLE' ? { customerId: partyId } : { supplierId: partyId }),
          invoiceDate: new Date().toISOString().slice(0, 10), dueDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
          currencyCode, isTaxInvoice, ...(isTaxInvoice ? { taxInvoiceNumber } : {}),
          ...(recurrenceFrequency ? { recurrenceFrequency } : {}),
          lines: [{ description, quantity, unitPrice, accountId, ...(taxRate ? { taxRate, taxAccountId } : {}) }],
        };
      } else if (kind === 'payment') {
        path = '/api/v1/payments';
        const paymentAmount = amount;
        const openInvoices = invoices.filter((invoice) => invoice.status === 'SENT' || invoice.status === 'PARTIALLY_PAID' || invoice.status === 'OVERDUE');
        const matches = openInvoices.filter((invoice) => invoice.direction === (direction === 'RECEIVABLE' ? 'RECEIVABLE' : 'PAYABLE') && (direction === 'RECEIVABLE' ? invoice.customerId === partyId : invoice.supplierId === partyId));
        const allocations = manualAllocations.filter((line) => line.invoiceId && line.amount);
        body = {
          direction: direction === 'RECEIVABLE' ? 'INBOUND' : 'OUTBOUND',
          ...(direction === 'RECEIVABLE' ? { customerId: partyId } : { supplierId: partyId }),
          treasuryAccountId, currencyCode, amount: paymentAmount,
          paymentDate: new Date().toISOString().slice(0, 10), allocationMode: allocations.length ? 'MANUAL' : 'FIFO',
          ...(allocations.length ? { allocations } : {}),
          ...(!matches.length ? { onAccountAccountId } : {}),
          methods: methodLines.filter((line) => line.amount).map((line) => ({ method: line.method, amount: line.amount })),
        };
      } else {
        path = kind === 'credit-note' ? '/api/v1/credit-notes' : '/api/v1/debit-notes';
        body = { invoiceId, reasonCode, reason, amount };
      }
      await salesRequest(path, { method: 'POST', headers: mutationHeaders(), body: JSON.stringify(body) });
      const destination = kind === 'credit-note' ? '/sales/credit-notes' : kind === 'debit-note' ? '/sales/debit-notes' : `/sales/${kind === 'quotation' ? 'quotations' : `${kind}s`}`;
      router.push(destination);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The document could not be created.');
    } finally {
      setSaving(false);
    }
  }

  const partyLabel = kind === 'invoice' || kind === 'payment' ? direction === 'RECEIVABLE' ? 'Customer' : 'Supplier' : 'Customer';
  const relevantInvoices = invoices.filter((invoice) => kind === 'credit-note' || kind === 'debit-note' ? invoice.direction === 'RECEIVABLE' && ['SENT', 'PARTIALLY_PAID', 'OVERDUE'].includes(invoice.status) : invoice.direction === (direction === 'RECEIVABLE' ? 'RECEIVABLE' : 'PAYABLE') && ['SENT', 'PARTIALLY_PAID', 'OVERDUE'].includes(invoice.status) && (direction === 'RECEIVABLE' ? invoice.customerId === partyId : invoice.supplierId === partyId));
  return <div className="mx-auto max-w-3xl space-y-5">
    {error && <Alert tone="danger" title="Could not prepare document">{error}</Alert>}
    <Card><CardHeader title={titles[kind]} description="Numbering and audit records are assigned by the server; submit the draft for approval when it is ready." />
      <CardBody><form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
        {(kind === 'invoice' || kind === 'payment') && <label className="space-y-1 text-sm">Direction<Select value={direction} onChange={(event) => { setDirection(event.target.value as 'RECEIVABLE' | 'PAYABLE'); setPartyId(''); }}><SelectOption value="RECEIVABLE">Customer / receivable</SelectOption><SelectOption value="PAYABLE">Supplier / payable</SelectOption></Select></label>}
        {kind !== 'credit-note' && kind !== 'debit-note' && <label className="space-y-1 text-sm">{partyLabel}<Select required value={partyId} onChange={(event) => setPartyId(event.target.value)}><SelectOption value="">Choose {partyLabel.toLowerCase()}</SelectOption>{eligibleParties.map((party) => <SelectOption key={party.id} value={party.id}>{party.party.code} Â· {party.party.displayName}</SelectOption>)}</Select></label>}
        {(kind === 'credit-note' || kind === 'debit-note') && <label className="space-y-1 text-sm">Invoice<Select required value={invoiceId} onChange={(event) => setInvoiceId(event.target.value)}><SelectOption value="">Choose invoice</SelectOption>{relevantInvoices.map((invoice) => <SelectOption key={invoice.id} value={invoice.id}>{invoice.number} Â· {invoice.currencyCode} Â· {invoice.status}</SelectOption>)}</Select></label>}
        {kind !== 'payment' && <label className="space-y-1 text-sm">Currency<Input required maxLength={3} value={currencyCode} onChange={(event) => setCurrencyCode(event.target.value.toUpperCase())} /></label>}
        {(kind === 'quotation' || kind === 'invoice') && <>
          <label className="space-y-1 text-sm">Line description<Input required value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          <label className="space-y-1 text-sm">Quantity<Input required type="number" min="0.000001" step="0.000001" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
          <label className="space-y-1 text-sm">Unit price<Input required type="number" min="0" step="0.000001" value={unitPrice} onChange={(event) => setUnitPrice(event.target.value)} /></label>
        </>}
        {kind === 'invoice' && <>
          <label className="space-y-1 text-sm">Posting account<Select required value={accountId} onChange={(event) => setAccountId(event.target.value)}><SelectOption value="">Choose {expectedLineType.toLowerCase()} account</SelectOption>{postableAccounts.filter((account) => account.type === expectedLineType).map((account) => <SelectOption key={account.id} value={account.id}>{account.code} Â· {account.name}</SelectOption>)}</Select></label>
          <label className="space-y-1 text-sm">Tax rate % (optional)<Input type="number" min="0" step="0.01" value={taxRate} onChange={(event) => setTaxRate(event.target.value)} /></label>
          {taxRate && <label className="space-y-1 text-sm">Tax account<Select required value={taxAccountId} onChange={(event) => setTaxAccountId(event.target.value)}><SelectOption value="">Choose tax account</SelectOption>{postableAccounts.filter((account) => account.type === taxType).map((account) => <SelectOption key={account.id} value={account.id}>{account.code} Â· {account.name}</SelectOption>)}</Select></label>}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={isTaxInvoice} onChange={(event) => setIsTaxInvoice(event.target.checked)} /> Issue as tax invoice</label>
          {isTaxInvoice && <label className="space-y-1 text-sm">Tax invoice number<Input required value={taxInvoiceNumber} onChange={(event) => setTaxInvoiceNumber(event.target.value)} /></label>}
          <label className="space-y-1 text-sm">Recurring schedule<Select value={recurrenceFrequency} onChange={(event) => setRecurrenceFrequency(event.target.value)}><SelectOption value="">One-off invoice</SelectOption><SelectOption value="MONTHLY">Monthly</SelectOption><SelectOption value="QUARTERLY">Quarterly</SelectOption><SelectOption value="ANNUALLY">Annually</SelectOption></Select></label>
        </>}
        {kind === 'payment' && <>
          <label className="space-y-1 text-sm">Amount<Input required type="number" min="0.000001" step="0.000001" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
          <label className="space-y-1 text-sm">Currency<Input required maxLength={3} value={currencyCode} onChange={(event) => setCurrencyCode(event.target.value.toUpperCase())} /></label>
          <label className="space-y-1 text-sm">Treasury account<Select required value={treasuryAccountId} onChange={(event) => setTreasuryAccountId(event.target.value)}><SelectOption value="">Choose treasury account</SelectOption>{treasury.filter((row) => row.currencyCode === currencyCode).map((row) => <SelectOption key={row.id} value={row.id}>{row.code} Â· {row.name}</SelectOption>)}</Select></label>
          <div className="space-y-2 md:col-span-2"><div className="flex items-center justify-between"><span className="text-sm font-medium">Payment methods</span><Button type="button" size="sm" variant="outline" onClick={() => setMethodLines((lines) => [...lines, { method: 'BANK_TRANSFER', amount: '' }])}>Add method</Button></div>
            {methodLines.map((line, index) => <div key={`method-${index}`} className="grid gap-2 sm:grid-cols-[2fr_1fr_auto]"><Select aria-label={`Payment method ${index + 1}`} value={line.method} onChange={(event) => setMethodLines((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, method: event.target.value } : row))}>{['BANK_TRANSFER', 'CASH', 'MOBILE_MONEY', 'PAYMENT_GATEWAY', 'CHEQUE', 'CARD', 'OTHER'].map((value) => <SelectOption key={value} value={value}>{value.replaceAll('_', ' ')}</SelectOption>)}</Select><Input aria-label={`Payment method amount ${index + 1}`} required type="number" min="0.000001" step="0.000001" placeholder="Amount" value={line.amount} onChange={(event) => setMethodLines((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, amount: event.target.value } : row))} />{methodLines.length > 1 && <Button type="button" size="sm" variant="outline" onClick={() => setMethodLines((rows) => rows.filter((_, rowIndex) => rowIndex !== index))}>Remove</Button>}</div>)}
          </div>
          <label className="space-y-1 text-sm">On-account posting account (if no open invoices)<Select value={onAccountAccountId} onChange={(event) => setOnAccountAccountId(event.target.value)}><SelectOption value="">Choose account</SelectOption>{postableAccounts.filter((account) => account.type === unappliedType).map((account) => <SelectOption key={account.id} value={account.id}>{account.code} Â· {account.name}</SelectOption>)}</Select></label>
          <div className="space-y-2 md:col-span-2"><div className="flex items-center justify-between"><span className="text-sm font-medium">Manual allocation (optional)</span><Button type="button" size="sm" variant="outline" onClick={() => setManualAllocations((lines) => [...lines, { invoiceId: '', amount: '' }])}>Add invoice allocation</Button></div>
            {manualAllocations.map((line, index) => <div key={`allocation-${index}`} className="grid gap-2 sm:grid-cols-[2fr_1fr_auto]"><Select aria-label={`Invoice allocation ${index + 1}`} value={line.invoiceId} onChange={(event) => setManualAllocations((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, invoiceId: event.target.value } : row))}><SelectOption value="">Choose open invoice</SelectOption>{relevantInvoices.map((invoice) => <SelectOption key={invoice.id} value={invoice.id}>{invoice.number} Â· {invoice.currencyCode} Â· {invoice.status}</SelectOption>)}</Select><Input aria-label={`Amount allocation ${index + 1}`} type="number" min="0.000001" step="0.000001" placeholder="Amount" value={line.amount} onChange={(event) => setManualAllocations((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, amount: event.target.value } : row))} /><Button type="button" size="sm" variant="outline" onClick={() => setManualAllocations((rows) => rows.filter((_, rowIndex) => rowIndex !== index))}>Remove</Button></div>)}
          </div>
        </>}
        {(kind === 'credit-note' || kind === 'debit-note') && <>
          <label className="space-y-1 text-sm">Amount<Input required type="number" min="0.000001" step="0.000001" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
          <label className="space-y-1 text-sm">Reason code<Select value={reasonCode} onChange={(event) => setReasonCode(event.target.value)}>{['RETURN', 'PRICING_ADJUSTMENT', 'DAMAGED_GOODS', 'DUPLICATE_BILLING', 'SERVICE_NOT_RENDERED', 'TAX_ADJUSTMENT', 'OVERCHARGE', 'UNDERCHARGE', 'OTHER'].map((value) => <SelectOption key={value} value={value}>{value.replaceAll('_', ' ')}</SelectOption>)}</Select></label>
          <label className="space-y-1 text-sm md:col-span-2">Reason<Input required minLength={5} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
        </>}
        <div className="flex gap-3 md:col-span-2"><Button type="submit" disabled={saving}>{saving ? 'Savingâ€¦' : 'Save draft'}</Button><Button type="button" variant="outline" onClick={() => router.back()}>Cancel</Button></div>
      </form></CardBody>
    </Card>
  </div>;
}

