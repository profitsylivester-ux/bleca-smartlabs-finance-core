'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState, Input, Select, SelectOption } from '@/components/ui';
import { formatDate } from '@/lib/format';

type Supplier = {
  id: string; status: string; masterDataStatus: string; paymentTermsDays: number; paymentCurrencyCode: string | null;
  performanceRating: string | null; deliveryRating: string | null; qualityRating: string | null; riskLevel: string;
  party: {
    id: string; code: string; kind: string; displayName: string; legalName: string | null; taxIdentifier: string | null;
    registrationNumber: string | null; email: string | null; phone: string | null; website: string | null;
    contacts: Array<{ id: string; fullName: string; title: string | null; email: string | null; phone: string | null; isPrimary: boolean }>;
    addresses: Array<{ id: string; type: string; addressLine1: string; addressLine2: string | null; city: string | null; region: string | null; countryCode: string; isPrimary: boolean }>;
  };
  bankDetails: Array<{ id: string; bankName: string; accountHolderName: string; accountNumberLast4: string; currencyCode: string | null; isPrimary: boolean }>;
  productsServices: Array<{ productService: { id: string; code: string; name: string; type: string } }>;
  taxObligations: Array<{ taxObligationId: string }>;
};
type Risk = { riskAlerts: string[]; bankDetailChangeRequests: Array<{ id: string; status: string; requestedAt: string }> };
type Communication = { id: string; channel: string; direction: string; subject: string | null; summary: string; contactedAt: string };
const tabs = ['Profile', 'Bank details', 'Performance', 'Tax obligations', 'Communications'] as const;
type Tab = typeof tabs[number];

export default function SupplierProfileClient({ id }: { id: string }) {
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [risk, setRisk] = useState<Risk | null>(null);
  const [communications, setCommunications] = useState<Communication[]>([]);
  const [tab, setTab] = useState<Tab>('Profile');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [channel, setChannel] = useState('EMAIL');
  const [summary, setSummary] = useState('');
  const [subject, setSubject] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [profileResponse, riskResponse] = await Promise.all([fetch(`/api/v1/suppliers/${id}`), fetch(`/api/v1/suppliers/${id}/risk`)]);
      const [profile, riskResult] = await Promise.all([profileResponse.json(), riskResponse.json()]) as [
        { data?: Supplier; error?: { message?: string } }, { data?: Risk },
      ];
      if (!profileResponse.ok) throw new Error(profile.error?.message ?? 'Could not load supplier profile.');
      setSupplier(profile.data ?? null); setRisk(riskResult.data ?? null);
      const communicationResponse = profile.data?.party.id ? await fetch(`/api/v1/parties/${profile.data.party.id}/communications`) : null;
      const communicationResult = communicationResponse ? await communicationResponse.json() as { data?: Communication[] } : null;
      setCommunications(communicationResponse?.ok ? communicationResult?.data ?? [] : []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load supplier profile.'); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function addCommunication(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await fetch(`/api/v1/parties/${supplier?.party.id}/communications`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ channel, direction: 'OUTBOUND', subject: subject || undefined, summary }),
    });
    const result = await response.json() as { error?: { message?: string } };
    if (!response.ok) { setError(result.error?.message ?? 'Could not record communication.'); return; }
    setSummary(''); setSubject(''); setNotice('Communication recorded.'); await load();
  }

  if (loading) return <Card><CardBody className="py-12 text-center text-sm text-muted-foreground">Loading supplier profile…</CardBody></Card>;
  if (error && !supplier) return <Alert tone="danger" title="Could not load supplier">{error}</Alert>;
  if (!supplier) return <EmptyState title="Supplier not found" body="This supplier may have been deactivated or is outside your organization." />;

  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><Link href="/suppliers" className="text-sm text-navy-700 hover:underline">← Suppliers</Link><h1 className="mt-2 text-2xl font-semibold">{supplier.party.displayName}</h1><p className="font-mono text-sm text-muted-foreground">{supplier.party.code}</p></div><div className="flex gap-2"><Badge tone={supplier.status === 'ACTIVE' ? 'success' : 'neutral'}>{supplier.status}</Badge><Badge tone={supplier.masterDataStatus === 'ACTIVE' ? 'success' : 'warning'}>Master data {supplier.masterDataStatus.replaceAll('_', ' ').toLowerCase()}</Badge><Link className="rounded-md bg-navy-700 px-3 py-2 text-sm font-medium text-white hover:bg-navy-800" href={`/suppliers/${id}/bank-details`}>Manage bank details</Link></div></div>
    {error && <Alert tone="danger">{error}</Alert>}{notice && <Alert tone="success">{notice}</Alert>}
    {risk?.riskAlerts.map((alert) => <Alert key={alert} tone="warning">{alert}</Alert>)}
    <Card><CardBody><div className="flex flex-wrap gap-2">{tabs.map((value) => <Button key={value} size="sm" variant={tab === value ? 'default' : 'outline'} onClick={() => setTab(value)}>{value}</Button>)}</div></CardBody></Card>
    {tab === 'Profile' && <div className="grid gap-5 lg:grid-cols-2"><Card><CardHeader title="Business details" /><CardBody><dl className="grid grid-cols-2 gap-3 text-sm"><dt className="text-muted-foreground">Type</dt><dd>{supplier.party.kind}</dd><dt className="text-muted-foreground">Legal name</dt><dd>{supplier.party.legalName ?? '—'}</dd><dt className="text-muted-foreground">Tax identifier</dt><dd>{supplier.party.taxIdentifier ?? '—'}</dd><dt className="text-muted-foreground">Registration number</dt><dd>{supplier.party.registrationNumber ?? '—'}</dd><dt className="text-muted-foreground">Email</dt><dd>{supplier.party.email ?? '—'}</dd><dt className="text-muted-foreground">Phone</dt><dd>{supplier.party.phone ?? '—'}</dd><dt className="text-muted-foreground">Payment terms</dt><dd>{supplier.paymentTermsDays} days</dd><dt className="text-muted-foreground">Payment currency</dt><dd>{supplier.paymentCurrencyCode ?? '—'}</dd></dl></CardBody></Card><Card><CardHeader title="Contacts and supplied products/services" /><CardBody className="space-y-3">{supplier.party.contacts.map((contact) => <div key={contact.id} className="rounded-md border p-3 text-sm"><strong>{contact.fullName}</strong>{contact.isPrimary ? ' · Primary' : ''}<div className="text-muted-foreground">{[contact.title, contact.email, contact.phone].filter(Boolean).join(' · ')}</div></div>)}{supplier.productsServices.length ? supplier.productsServices.map((item) => <div key={item.productService.id} className="rounded-md border p-3 text-sm"><Badge tone="neutral">{item.productService.type}</Badge> <span className="font-mono">{item.productService.code}</span> · {item.productService.name}</div>) : <EmptyState title="No products or services linked" body="Link supplier offerings to the existing product/service catalogue." />}</CardBody></Card></div>}
    {tab === 'Bank details' && <Card><CardHeader title="Payment details" actions={<Link className="text-sm text-navy-700 hover:underline" href={`/suppliers/${id}/bank-details`}>View change history →</Link>} /><CardBody>{supplier.bankDetails.length ? <div className="space-y-3">{supplier.bankDetails.map((bank) => <div key={bank.id} className="rounded-md border p-3 text-sm"><div className="font-medium">{bank.bankName}{bank.isPrimary ? ' · Primary' : ''}</div><div>{bank.accountHolderName} · •••• {bank.accountNumberLast4}</div><div className="text-muted-foreground">{bank.currencyCode ?? 'Currency not set'}</div></div>)}</div> : <EmptyState title="No active bank details" body="A verified and approved change request is required to add payment details." />}</CardBody></Card>}
    {tab === 'Performance' && <Card><CardHeader title="Supplier performance" description="Ratings are maintained through approved supplier master-data changes." /><CardBody className="grid gap-3 sm:grid-cols-3">{[['Performance', supplier.performanceRating], ['Delivery', supplier.deliveryRating], ['Quality', supplier.qualityRating]].map(([label, rating]) => <div className="rounded-md border p-4" key={label as string}><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 text-xl font-semibold">{rating ?? 'Not rated'}{rating ? ' / 5' : ''}</div></div>)}</CardBody></Card>}
    {tab === 'Tax obligations' && <Card><CardHeader title="Linked tax obligations" /><CardBody>{supplier.taxObligations.length ? <div className="space-y-2">{supplier.taxObligations.map((item) => <div className="rounded-md border p-3 font-mono text-sm" key={item.taxObligationId}>{item.taxObligationId}</div>)}</div> : <EmptyState title="No tax obligations linked" body="Tax obligation records will be linked when M13 introduces the tax-obligation model." />}</CardBody></Card>}
    {tab === 'Communications' && <div className="space-y-4"><Card><CardHeader title="Record communication" /><CardBody><form onSubmit={(event) => void addCommunication(event)} className="grid gap-3 md:grid-cols-[1fr_2fr_2fr_auto]"><Select aria-label="Channel" value={channel} onChange={(event) => setChannel(event.target.value)}>{['EMAIL', 'PHONE', 'MEETING', 'LETTER', 'OTHER'].map((value) => <SelectOption key={value} value={value}>{value}</SelectOption>)}</Select><Input aria-label="Subject" placeholder="Subject" value={subject} onChange={(event) => setSubject(event.target.value)} /><Input aria-label="Summary" placeholder="Summary" value={summary} onChange={(event) => setSummary(event.target.value)} required /><Button type="submit">Save log</Button></form></CardBody></Card><Card><CardHeader title="Communication history" /><CardBody>{communications.length ? <div className="space-y-3">{communications.map((item) => <div key={item.id} className="rounded-md border p-3"><div className="flex justify-between gap-2 text-sm"><strong>{item.subject ?? item.channel}</strong><span className="text-muted-foreground">{formatDate(item.contactedAt)} · {item.direction}</span></div><p className="mt-2 text-sm">{item.summary}</p></div>)}</div> : <EmptyState title="No communications recorded" body="Add a call, email, meeting, or letter above." />}</CardBody></Card></div>}
  </div>;
}
