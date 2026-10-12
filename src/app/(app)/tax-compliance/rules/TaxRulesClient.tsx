'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState, Input, Select, SelectOption, Table, Td, Th } from '@/components/ui';

type TaxRuleRow = {
  id: string; code: string; name: string; type: string; jurisdiction: string;
  ratePercent: string | null; isInclusive: boolean; calculationBasis: string;
  effectiveFrom: string; effectiveTo: string | null; isActive: boolean; isVerified: boolean;
};

const TYPES = ['VAT', 'WITHHOLDING', 'INCOME_TAX', 'TURNOVER_TAX', 'FILING_FEE', 'STAMP_DUTY', 'OTHER'];

export default function TaxRulesClient() {
  const [rows, setRows] = useState<TaxRuleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState('VAT');
  const [jurisdiction, setJurisdiction] = useState('');
  const [rate, setRate] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const response = await fetch('/api/v1/tax-rules');
      const result = await response.json() as { data?: TaxRuleRow[]; error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? 'Could not load tax rules.');
      setRows(result.data ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load tax rules.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function createRule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(null); setNotice(null);
    try {
      const response = await fetch('/api/v1/tax-rules', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({
          code: code.trim().toUpperCase(),
          name: name.trim(),
          type,
          jurisdiction: jurisdiction.trim(),
          ratePercent: rate.trim(),
          isInclusive: false,
          calculationBasis: 'EXCLUSIVE',
          effectiveFrom: new Date().toISOString().slice(0, 10),
        }),
      });
      const result = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? 'Could not create tax rule.');
      setCode(''); setName(''); setJurisdiction(''); setRate('');
      setNotice('Tax rule recorded. Accountant verification is still required before it is trusted.');
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create tax rule.'); }
    finally { setSaving(false); }
  }

  return <div className="space-y-5">
    {error && <Alert tone="danger" title="Tax rule request failed">{error}</Alert>}
    {notice && <Alert tone="success">{notice}</Alert>}
    <Card><CardHeader title="Tax rules" description="Configured rates drive every calculation. Nothing is hardcoded." /><CardBody>
      <form onSubmit={(event) => void createRule(event)} className="mb-5 grid gap-3 rounded-lg border border-border p-4 md:grid-cols-[1fr_2fr_1fr_2fr_1fr_auto]">
        <Input aria-label="Rule code" placeholder="Code" value={code} onChange={(event) => setCode(event.target.value)} required />
        <Input aria-label="Rule name" placeholder="Rule name" value={name} onChange={(event) => setName(event.target.value)} required />
        <Select aria-label="Rule type" value={type} onChange={(event) => setType(event.target.value)}>{TYPES.map((value) => <SelectOption key={value} value={value}>{value}</SelectOption>)}</Select>
        <Input aria-label="Jurisdiction" placeholder="Jurisdiction" value={jurisdiction} onChange={(event) => setJurisdiction(event.target.value)} required />
        <Input aria-label="Rate percent" placeholder="Rate %" value={rate} onChange={(event) => setRate(event.target.value)} required inputMode="decimal" />
        <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'New rule'}</Button>
      </form>
      {loading ? <p className="py-8 text-center text-sm text-muted-foreground">Loading tax rules…</p> : rows.length === 0 ? <EmptyState title="No tax rules configured" body="Add the first rule above. Calculations refuse to run without one." /> : <Table><thead><tr><Th>Rule</Th><Th>Type</Th><Th>Rate</Th><Th>Effective</Th><Th>Status</Th></tr></thead><tbody>{rows.map((rule) => <tr key={rule.id}>
        <Td><span className="font-medium">{rule.name}</span><div className="font-mono text-xs text-muted-foreground">{rule.code} · {rule.jurisdiction}</div></Td>
        <Td>{rule.type} · {rule.calculationBasis}</Td>
        <Td>{rule.ratePercent ?? '—'}{rule.ratePercent ? '%' : ''}</Td>
        <Td>{rule.effectiveFrom.slice(0, 10)}{rule.effectiveTo ? ` → ${rule.effectiveTo.slice(0, 10)}` : ''}</Td>
        <Td><div className="flex flex-col items-start gap-1"><Badge tone={rule.isActive ? 'success' : 'neutral'}>{rule.isActive ? 'Active' : 'Inactive'}</Badge>{rule.isVerified ? <Badge tone="info">Verified</Badge> : <Badge tone="warning">Awaiting verification</Badge>}</div></Td>
      </tr>)}</tbody></Table>}
    </CardBody></Card>
  </div>;
}
