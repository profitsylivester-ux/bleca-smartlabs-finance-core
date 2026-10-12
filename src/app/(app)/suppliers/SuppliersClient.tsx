'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState, Input, Select, SelectOption, Table, Td, Th } from '@/components/ui';
import { formatDate } from '@/lib/format';

type SupplierRow = {
  id: string; status: string; masterDataStatus: string; riskLevel: string;
  paymentTermsDays: number; paymentCurrencyCode: string | null;
  performanceRating: string | null; deliveryRating: string | null; qualityRating: string | null;
  createdAt: string; party: { code: string; displayName: string; taxIdentifier: string | null; email: string | null; phone: string | null };
};

export default function SuppliersClient() {
  const [rows, setRows] = useState<SupplierRow[]>([]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'status' | 'riskLevel' | 'createdAt'>('name');
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const params = new URLSearchParams({ page: String(page), pageSize: '20' });
    if (query.trim()) params.set('search', query.trim());
    if (status) params.set('status', status);
    try {
      const response = await fetch(`/api/v1/suppliers?${params.toString()}`);
      const result = await response.json() as { data?: SupplierRow[]; count?: number; error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? 'Could not load suppliers.');
      setRows(result.data ?? []); setTotal(result.count ?? 0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load suppliers.');
    } finally { setLoading(false); }
  }, [page, query, status]);
  useEffect(() => { void load(); }, [load]);

  const sorted = useMemo(() => [...rows].sort((a, b) => {
    const left = sortBy === 'name' ? a.party.displayName : sortBy === 'status' ? a.status : sortBy === 'riskLevel' ? a.riskLevel : a.createdAt;
    const right = sortBy === 'name' ? b.party.displayName : sortBy === 'status' ? b.status : sortBy === 'riskLevel' ? b.riskLevel : b.createdAt;
    const comparison = left.localeCompare(right);
    return direction === 'asc' ? comparison : -comparison;
  }), [direction, rows, sortBy]);

  async function createSupplier(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setCreating(true); setError(null); setNotice(null);
    try {
      const response = await fetch('/api/v1/suppliers', {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({ code: code.trim().toUpperCase(), displayName: name.trim(), kind: 'COMPANY' }),
      });
      const result = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? 'Could not create supplier.');
      setCode(''); setName(''); setNotice('Supplier created and sent for master data approval.'); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create supplier.'); }
    finally { setCreating(false); }
  }

  const pages = Math.max(1, Math.ceil(total / 20));
  return <div className="space-y-5">
    {error && <Alert tone="danger" title="Supplier request failed">{error}</Alert>}{notice && <Alert tone="success">{notice}</Alert>}
    <Card><CardHeader title="Suppliers" description="Business, tax, payment, performance, and risk profiles." /><CardBody>
      <form onSubmit={(event) => void createSupplier(event)} className="mb-5 grid gap-3 rounded-lg border border-border p-4 md:grid-cols-[1fr_2fr_auto]">
        <Input aria-label="Supplier code" placeholder="Supplier code" value={code} onChange={(event) => setCode(event.target.value)} required minLength={2} />
        <Input aria-label="Supplier name" placeholder="Supplier business name" value={name} onChange={(event) => setName(event.target.value)} required />
        <Button type="submit" disabled={creating}>{creating ? 'Creating…' : 'New supplier'}</Button>
      </form>
      <div className="mb-4 grid gap-3 md:grid-cols-3">
        <Input aria-label="Search suppliers" placeholder="Search name, code, tax ID" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} />
        <Select aria-label="Filter supplier status" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><SelectOption value="">All statuses</SelectOption>{['PROSPECT', 'ACTIVE', 'INACTIVE', 'BLOCKED'].map((value) => <SelectOption key={value} value={value}>{value}</SelectOption>)}</Select>
        <div className="flex gap-2"><Select aria-label="Sort suppliers" value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)}><SelectOption value="name">Name</SelectOption><SelectOption value="status">Status</SelectOption><SelectOption value="riskLevel">Risk</SelectOption><SelectOption value="createdAt">Date added</SelectOption></Select><Button variant="outline" onClick={() => setDirection((value) => value === 'asc' ? 'desc' : 'asc')}>{direction === 'asc' ? 'Ascending' : 'Descending'}</Button></div>
      </div>
      {loading ? <p className="py-8 text-center text-sm text-muted-foreground">Loading suppliers…</p> : sorted.length === 0 ? <EmptyState title="No suppliers found" body="Adjust your filters or add a supplier profile." /> : <Table><thead><tr><Th>Supplier</Th><Th>Status</Th><Th>Risk</Th><Th>Tax ID</Th><Th>Ratings</Th><Th>Added</Th></tr></thead><tbody>{sorted.map((supplier) => <tr key={supplier.id}>
        <Td><Link className="font-medium text-navy-700 hover:underline" href={`/suppliers/${supplier.id}`}>{supplier.party.displayName}</Link><div className="font-mono text-xs text-muted-foreground">{supplier.party.code}</div></Td>
        <Td><div className="flex flex-col items-start gap-1"><Badge tone={supplier.status === 'ACTIVE' ? 'success' : 'neutral'}>{supplier.status}</Badge>{supplier.masterDataStatus !== 'ACTIVE' && <Badge tone="warning">Approval pending</Badge>}</div></Td>
        <Td><Badge tone={supplier.riskLevel === 'HIGH' || supplier.riskLevel === 'CRITICAL' ? 'danger' : 'neutral'}>{supplier.riskLevel}</Badge></Td>
        <Td>{supplier.party.taxIdentifier ?? '—'}</Td><Td>Performance {supplier.performanceRating ?? '—'} · Delivery {supplier.deliveryRating ?? '—'} · Quality {supplier.qualityRating ?? '—'}</Td><Td>{formatDate(supplier.createdAt)}</Td>
      </tr>)}</tbody></Table>}
      <div className="mt-4 flex items-center justify-between text-sm"><span>{total} suppliers · page {page} of {pages}</span><div className="flex gap-2"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</Button><Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>Next</Button></div></div>
    </CardBody></Card>
  </div>;
}
