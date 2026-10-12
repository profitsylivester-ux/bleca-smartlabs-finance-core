'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, Button, Card, CardBody, CardHeader, Input, Select, SelectOption, Table, Td, Th } from '@/components/ui';

type Policy = { id: string; name: string; category: string; retentionMonths: number; action: string; legalBasis: string; isActive: boolean };
const categories = [
  'RECEIPT', 'INVOICE', 'QUOTATION', 'CONTRACT', 'GRANT_DOCUMENT', 'TAX_DOCUMENT', 'COMPLIANCE_DOCUMENT',
  'FINANCIAL_EVIDENCE', 'ASSET_DOCUMENT', 'SUPPLIER_DOCUMENT', 'CUSTOMER_DOCUMENT', 'BANK_STATEMENT',
  'RECONCILIATION_SUPPORT', 'OTHER',
];

export default function RetentionPoliciesClient({ canConfigure }: { canConfigure: boolean }) {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('FINANCIAL_EVIDENCE');
  const [months, setMonths] = useState('84');
  const [action, setAction] = useState('ARCHIVE');
  const [legalBasis, setLegalBasis] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    const response = await fetch('/api/v1/retention-policies');
    const result = await response.json() as { data?: Policy[]; error?: { message?: string } };
    if (!response.ok) throw new Error(result.error?.message ?? 'Could not load retention policies.');
    setPolicies(result.data ?? []);
  }

  useEffect(() => {
    void load().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not load retention policies.'));
  }, []);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null); setNotice(null);
    try {
      const response = await fetch('/api/v1/retention-policies', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, category, retentionMonths: Number(months), action, legalBasis }),
      });
      const result = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? 'Could not save the retention policy.');
      setNotice(`Policy saved for ${category.replaceAll('_', ' ')}.`);
      setName(''); setLegalBasis('');
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save the retention policy.'); }
  }

  return <div className="space-y-5">
    <Link className="text-sm text-navy-700 hover:underline" href="/documents">← Document library</Link>
    {error && <Alert tone="danger" title="Retention policy request failed">{error}</Alert>}
    {notice && <Alert tone="success" title="Retention policy saved">{notice}</Alert>}
    {canConfigure && <Card><CardHeader title="Set a category policy" description="Each category has one active retention policy. Actual removal remains a soft delete." /><CardBody><form onSubmit={save} className="grid gap-3 md:grid-cols-2">
      <Input aria-label="Policy name" placeholder="Policy name" value={name} onChange={(event) => setName(event.target.value)} required />
      <Select aria-label="Document category" value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((value) => <SelectOption key={value} value={value}>{value.replaceAll('_', ' ')}</SelectOption>)}</Select>
      <Input aria-label="Retention months" type="number" min={0} max={1200} value={months} onChange={(event) => setMonths(event.target.value)} required />
      <Select aria-label="Retention action" value={action} onChange={(event) => setAction(event.target.value)}><SelectOption value="ARCHIVE">Archive</SelectOption><SelectOption value="DELETE">Soft delete</SelectOption><SelectOption value="RETAIN_FOREVER">Retain forever</SelectOption></Select>
      <label className="space-y-2 text-sm font-medium md:col-span-2">Legal basis<textarea className="min-h-20 w-full rounded-lg border border-border bg-background p-3 text-sm" value={legalBasis} onChange={(event) => setLegalBasis(event.target.value)} required /></label>
      <Button type="submit" className="justify-self-start">Save policy</Button>
    </form></CardBody></Card>}
    <Card><CardHeader title="Retention policies" description="The scheduled maintenance helper applies these policies and skips documents under active legal hold." /><CardBody>
      {policies.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No retention policies configured.</p> : <Table><thead><tr><Th>Category</Th><Th>Policy</Th><Th>Retention</Th><Th>Action</Th><Th>Legal basis</Th></tr></thead><tbody>{policies.map((policy) => <tr key={policy.id}><Td>{policy.category.replaceAll('_', ' ')}</Td><Td>{policy.name}{!policy.isActive && ' · inactive'}</Td><Td>{policy.action === 'RETAIN_FOREVER' ? 'Forever' : `${policy.retentionMonths} months`}</Td><Td>{policy.action.replaceAll('_', ' ')}</Td><Td>{policy.legalBasis}</Td></tr>)}</tbody></Table>}
    </CardBody></Card>
  </div>;
}
