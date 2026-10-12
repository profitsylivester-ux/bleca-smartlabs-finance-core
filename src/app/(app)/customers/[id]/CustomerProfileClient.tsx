'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState, Input, Select, SelectOption, Table, Td, Th } from '@/components/ui';
import { formatAmount, formatDate } from '@/lib/format';

type Customer = {
  id: string; status: string; masterDataStatus: string; paymentTermsDays: number;
  creditLimit: string; currencyCode: string; relationshipOwnerId: string | null; riskLevel: string;
  creditHoldReason: string | null; badDebtAmount: string; outstandingBalance: string;
  party: {
    id: string; code: string; kind: string; displayName: string; legalName: string | null;
    firstName: string | null; lastName: string | null; taxIdentifier: string | null;
    registrationNumber: string | null; email: string | null; phone: string | null; website: string | null;
    contacts: Array<{ id: string; fullName: string; title: string | null; email: string | null; phone: string | null; isPrimary: boolean }>;
    addresses: Array<{ id: string; type: string; addressLine1: string; addressLine2: string | null; city: string | null; region: string | null; postalCode: string | null; countryCode: string; isPrimary: boolean }>;
  };
  receivables: Array<{ id: string; invoiceReference: string; outstandingAmount: string; currencyCode: string; dueAt: string; status: string }>;
  creditHolds: Array<{ id: string; status: string; reason: string; heldAt: string; releaseReason: string | null }>;
};
type Aging = { buckets: Record<string, string>; totalOutstanding: string; overdueCount: number; overdueInvoices: Array<{ id: string; invoiceReference: string; outstandingAmount: string; currencyCode: string; dueAt: string; daysPastDue: number }>; riskAlerts: string[] };
type Communication = { id: string; channel: string; direction: string; subject: string | null; summary: string; contactedAt: string; followUpAt: string | null };
type Version = { id: string; versionNumber: number; snapshot: unknown; createdAt: string; effectiveFrom: string };

const tabs = ['Profile', 'Aging', 'Communications', 'Invoices & payments', 'Documents', 'History'] as const;
type Tab = typeof tabs[number];

export default function CustomerProfileClient({ id }: { id: string }) {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [aging, setAging] = useState<Aging | null>(null);
  const [communications, setCommunications] = useState<Communication[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [tab, setTab] = useState<Tab>('Profile');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [channel, setChannel] = useState('EMAIL');
  const [summary, setSummary] = useState('');
  const [subject, setSubject] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [profileResponse, agingResponse] = await Promise.all([
        fetch(`/api/v1/customers/${id}`), fetch(`/api/v1/customers/${id}/aging`),
      ]);
      const [profile, agingResult] = await Promise.all([profileResponse.json(), agingResponse.json()]) as [
        { data?: Customer; versions?: Version[]; error?: { message?: string } },
        { data?: Aging; error?: { message?: string } },
      ];
      if (!profileResponse.ok) throw new Error(profile.error?.message ?? 'Could not load this customer.');
      setCustomer(profile.data ?? null);
      setVersions(profile.versions ?? []);
      setAging(agingResponse.ok ? agingResult.data ?? null : null);
      const communicationsResponse = profile.data?.party.id ? await fetch(`/api/v1/parties/${profile.data.party.id}/communications`) : null;
      const communicationResult = communicationsResponse ? await communicationsResponse.json() as { data?: Communication[] } : null;
      setCommunications(communicationsResponse?.ok ? communicationResult?.data ?? [] : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load this customer.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  async function creditAction(path: 'credit-hold' | 'release') {
    const reason = window.prompt(path === 'release' ? 'Reason for approving release' : 'Reason for placing the customer on hold');
    if (!reason) return;
    setNotice(null);
    setError(null);
    const response = await fetch(`/api/v1/customers/${id}/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ reason }),
    });
    const result = await response.json() as { error?: { message?: string } };
    if (!response.ok) { setError(result.error?.message ?? 'The credit action could not be completed.'); return; }
    setNotice(path === 'release' ? 'Credit hold released.' : 'Customer placed on credit hold.');
    await load();
  }

  async function addCommunication(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await fetch(`/api/v1/parties/${customer?.party.id}/communications`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ channel, direction: 'OUTBOUND', subject: subject || undefined, summary }),
    });
    const result = await response.json() as { error?: { message?: string } };
    if (!response.ok) { setError(result.error?.message ?? 'Could not record communication.'); return; }
    setSummary(''); setSubject(''); setNotice('Communication recorded.'); await load();
  }

  if (loading) return <Card><CardBody className="py-12 text-center text-sm text-muted-foreground">Loading customer profile…</CardBody></Card>;
  if (error && !customer) return <Alert tone="danger" title="Could not load customer">{error}</Alert>;
  if (!customer) return <EmptyState title="Customer not found" body="This customer may have been deactivated or is outside your organization." />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><Link href="/customers" className="text-sm text-navy-700 hover:underline">← Customers</Link><h1 className="mt-2 text-2xl font-semibold">{customer.party.displayName}</h1><p className="font-mono text-sm text-muted-foreground">{customer.party.code}</p></div>
        <div className="flex flex-wrap gap-2"><Badge tone={customer.status === 'ACTIVE' ? 'success' : customer.status === 'CREDIT_HOLD' || customer.status === 'BLOCKED' ? 'danger' : 'warning'}>{customer.status.replaceAll('_', ' ')}</Badge><Badge tone={customer.masterDataStatus === 'ACTIVE' ? 'success' : 'warning'}>Master data {customer.masterDataStatus.replaceAll('_', ' ').toLowerCase()}</Badge>
          {customer.status === 'CREDIT_HOLD' ? <Button variant="outline" onClick={() => void creditAction('release')}>Release credit hold</Button> : <Button variant="outline" onClick={() => void creditAction('credit-hold')}>Place on credit hold</Button>}
        </div>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}{notice && <Alert tone="success">{notice}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card><CardBody><p className="text-xs text-muted-foreground">Outstanding balance</p><p className="mt-1 text-lg font-semibold">{formatAmount(Number(customer.outstandingBalance), customer.currencyCode)}</p></CardBody></Card>
        <Card><CardBody><p className="text-xs text-muted-foreground">Credit limit</p><p className="mt-1 text-lg font-semibold">{formatAmount(Number(customer.creditLimit), customer.currencyCode)}</p></CardBody></Card>
        <Card><CardBody><p className="text-xs text-muted-foreground">Risk level</p><p className="mt-1 text-lg font-semibold">{customer.riskLevel}</p></CardBody></Card>
        <Card><CardBody><p className="text-xs text-muted-foreground">Payment terms</p><p className="mt-1 text-lg font-semibold">{customer.paymentTermsDays} days</p></CardBody></Card>
      </div>
      <Card><CardBody><div className="flex flex-wrap gap-2">{tabs.map((value) => <Button key={value} size="sm" variant={tab === value ? 'default' : 'outline'} onClick={() => setTab(value)}>{value}</Button>)}</div></CardBody></Card>

      {tab === 'Profile' && <div className="grid gap-5 lg:grid-cols-2">
        <Card><CardHeader title="Business and tax details" /><CardBody><dl className="grid grid-cols-2 gap-3 text-sm"><dt className="text-muted-foreground">Type</dt><dd>{customer.party.kind}</dd><dt className="text-muted-foreground">Legal name</dt><dd>{customer.party.legalName ?? '—'}</dd><dt className="text-muted-foreground">Tax identifier</dt><dd>{customer.party.taxIdentifier ?? '—'}</dd><dt className="text-muted-foreground">Registration</dt><dd>{customer.party.registrationNumber ?? '—'}</dd><dt className="text-muted-foreground">Email</dt><dd>{customer.party.email ?? '—'}</dd><dt className="text-muted-foreground">Phone</dt><dd>{customer.party.phone ?? '—'}</dd><dt className="text-muted-foreground">Relationship owner</dt><dd>{customer.relationshipOwnerId ?? '—'}</dd><dt className="text-muted-foreground">Bad debt tracked</dt><dd>{formatAmount(Number(customer.badDebtAmount), customer.currencyCode)}</dd></dl>{customer.creditHoldReason && <Alert tone="warning" title="Credit hold reason">{customer.creditHoldReason}</Alert>}</CardBody></Card>
        <Card><CardHeader title="Contacts and addresses" /><CardBody className="space-y-4">{customer.party.contacts.length === 0 && customer.party.addresses.length === 0 ? <EmptyState title="No contacts or addresses" body="Add contact and address records through the party management API." /> : null}{customer.party.contacts.map((contact) => <div key={contact.id} className="rounded-md border p-3 text-sm"><div className="font-medium">{contact.fullName}{contact.isPrimary ? ' · Primary' : ''}</div><div className="text-muted-foreground">{[contact.title, contact.email, contact.phone].filter(Boolean).join(' · ')}</div></div>)}{customer.party.addresses.map((address) => <div key={address.id} className="rounded-md border p-3 text-sm"><div className="font-medium">{address.type}{address.isPrimary ? ' · Primary' : ''}</div><div>{[address.addressLine1, address.addressLine2, address.city, address.region, address.postalCode, address.countryCode].filter(Boolean).join(', ')}</div></div>)}</CardBody></Card>
      </div>}

      {tab === 'Aging' && <Card><CardHeader title="Receivables aging" description={aging ? `As of today · ${aging.overdueCount} overdue invoice(s)` : 'Aging is based on approved invoice receivables.'} /><CardBody>{aging ? <><div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">{([['Current', 'current'], ['0–30 days', 'days0To30'], ['31–60 days', 'days31To60'], ['61–90 days', 'days61To90'], ['90+ days', 'days90Plus']] as const).map(([label, key]) => <div className="rounded-md border p-3" key={key}><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 font-mono font-semibold">{formatAmount(Number(aging.buckets[key] ?? 0), customer.currencyCode)}</div></div>)}</div><p className="mb-4 text-sm font-medium">Total outstanding: {formatAmount(Number(aging.totalOutstanding), customer.currencyCode)}</p>{aging.riskAlerts.map((alert) => <Alert key={alert} tone="warning">{alert}</Alert>)}{aging.overdueInvoices.length ? <Table><thead><tr><Th>Invoice</Th><Th>Due</Th><Th>Days overdue</Th><Th>Outstanding</Th></tr></thead><tbody>{aging.overdueInvoices.map((invoice) => <tr key={invoice.id}><Td>{invoice.invoiceReference}</Td><Td>{formatDate(invoice.dueAt)}</Td><Td>{invoice.daysPastDue}</Td><Td>{formatAmount(Number(invoice.outstandingAmount), invoice.currencyCode)}</Td></tr>)}</tbody></Table> : <EmptyState title="No overdue invoices" body="Overdue invoices will appear here once M11 invoice records are linked." />}</> : <EmptyState title="No receivables yet" body="Aging data appears after M11 invoices are linked to customer receivables." />}</CardBody></Card>}

      {tab === 'Communications' && <div className="space-y-4"><Card><CardHeader title="Record communication" description="Communication history is shared across customer and supplier parties." /><CardBody><form onSubmit={(event) => void addCommunication(event)} className="grid gap-3 md:grid-cols-[1fr_2fr_2fr_auto]"><Select aria-label="Channel" value={channel} onChange={(event) => setChannel(event.target.value)}>{['EMAIL', 'PHONE', 'MEETING', 'LETTER', 'OTHER'].map((value) => <SelectOption key={value} value={value}>{value}</SelectOption>)}</Select><Input aria-label="Subject" placeholder="Subject" value={subject} onChange={(event) => setSubject(event.target.value)} /><Input aria-label="Summary" placeholder="Summary" value={summary} onChange={(event) => setSummary(event.target.value)} required /><Button type="submit">Save log</Button></form></CardBody></Card><Card><CardHeader title="Communication history" /><CardBody>{communications.length === 0 ? <EmptyState title="No communications recorded" body="Add a call, email, meeting, or letter above." /> : <div className="space-y-3">{communications.map((item) => <div key={item.id} className="rounded-md border p-3"><div className="flex justify-between gap-2 text-sm"><strong>{item.subject ?? item.channel}</strong><span className="text-muted-foreground">{formatDate(item.contactedAt)} · {item.direction}</span></div><p className="mt-2 text-sm">{item.summary}</p>{item.followUpAt && <p className="mt-1 text-xs text-muted-foreground">Follow up {formatDate(item.followUpAt)}</p>}</div>)}</div>}</CardBody></Card></div>}

      {tab === 'Invoices & payments' && <Card><CardHeader title="Invoices and payments" /><CardBody><EmptyState title="Invoice and payment history will appear here" body="M11 owns invoice, payment, and allocation records; the M10 customer receivable view is available in Aging." /></CardBody></Card>}
      {tab === 'Documents' && <Card><CardHeader title="Documents" /><CardBody><EmptyState title="Customer documents" body="Document linking and evidence uploads are part of M12. Supplier bank changes currently require an evidence document ID." /></CardBody></Card>}
      {tab === 'History' && <Card><CardHeader title="Master data version history" /><CardBody>{versions.length === 0 ? <EmptyState title="No approved versions yet" body="Approved profile changes are preserved here." /> : <Table><thead><tr><Th>Version</Th><Th>Effective from</Th><Th>Saved</Th><Th>Snapshot</Th></tr></thead><tbody>{versions.map((version) => <tr key={version.id}><Td>{version.versionNumber}</Td><Td>{formatDate(version.effectiveFrom)}</Td><Td>{formatDate(version.createdAt)}</Td><Td><code className="text-xs">{JSON.stringify(version.snapshot)}</code></Td></tr>)}</tbody></Table>}</CardBody></Card>}
    </div>
  );
}
