'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState, Input, Select, SelectOption, Table, Td, Th } from '@/components/ui';
import { formatAmount, formatDate } from '@/lib/format';

type CustomerRow = {
  id: string;
  status: string;
  masterDataStatus: string;
  creditLimit: string;
  currencyCode: string;
  riskLevel: string;
  party: { code: string; displayName: string; legalName: string | null; email: string | null; phone: string | null; taxIdentifier: string | null };
  createdAt: string;
};

const tones: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  PROSPECT: 'info', ACTIVE: 'success', INACTIVE: 'neutral', CREDIT_HOLD: 'danger', BLOCKED: 'danger',
};

export default function CustomersClient() {
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'status' | 'creditLimit' | 'createdAt'>('name');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ page: String(page), pageSize: '20' });
    if (query.trim()) params.set('search', query.trim());
    if (status) params.set('status', status);
    try {
      const response = await fetch(`/api/v1/customers?${params.toString()}`);
      const result = await response.json() as { data?: CustomerRow[]; count?: number; error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? 'Could not load customers.');
      setRows(result.data ?? []);
      setTotal(result.count ?? 0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load customers.');
    } finally {
      setLoading(false);
    }
  }, [page, query, status]);

  useEffect(() => { void load(); }, [load]);

  const sorted = useMemo(() => [...rows].sort((a, b) => {
    let comparison = 0;
    if (sortBy === 'name') comparison = a.party.displayName.localeCompare(b.party.displayName);
    if (sortBy === 'status') comparison = a.status.localeCompare(b.status);
    if (sortBy === 'creditLimit') comparison = Number(a.creditLimit) - Number(b.creditLimit);
    if (sortBy === 'createdAt') comparison = a.createdAt.localeCompare(b.createdAt);
    return sortDirection === 'asc' ? comparison : -comparison;
  }), [rows, sortBy, sortDirection]);

  async function createCustomer(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch('/api/v1/customers', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({ code: newCode.trim().toUpperCase(), displayName: newName.trim(), kind: 'COMPANY' }),
      });
      const result = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? 'Could not create customer.');
      setNewCode('');
      setNewName('');
      setNotice('Customer created and sent for master data approval.');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create customer.');
    } finally {
      setCreating(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / 20));
  return (
    <div className="space-y-5">
      {error && <Alert tone="danger" title="Customer request failed">{error}</Alert>}
      {notice && <Alert tone="success" title="Customer saved">{notice}</Alert>}
      <Card>
        <CardHeader title="Customers" description="Customer profiles, credit controls, risk, and receivables."  actions={<Button onClick={() => setCreating(true)} className="bg-navy-800 text-white">+ New Customer</Button>} />
        <CardBody>
          <form onSubmit={createCustomer} className="mb-5 grid gap-3 rounded-lg border border-border p-4 md:grid-cols-[1fr_2fr_auto]">
            <Input aria-label="Customer code" placeholder="Customer code" value={newCode} onChange={(event) => setNewCode(event.target.value)} required minLength={2} />
            <Input aria-label="Customer name" placeholder="Individual or company name" value={newName} onChange={(event) => setNewName(event.target.value)} required />
            <Button type="submit" disabled={creating}>{creating ? 'Creating…' : 'New customer'}</Button>
          </form>
          <div className="mb-4 grid gap-3 md:grid-cols-3">
            <Input aria-label="Search customers" placeholder="Search name, code, tax ID" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} />
            <Select aria-label="Filter customer status" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}>
              <SelectOption value="">All statuses</SelectOption>
              {['PROSPECT', 'ACTIVE', 'INACTIVE', 'CREDIT_HOLD', 'BLOCKED'].map((value) => <SelectOption key={value} value={value}>{value.replaceAll('_', ' ')}</SelectOption>)}
            </Select>
            <div className="flex gap-2">
              <Select aria-label="Sort customers" value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)}>
                <SelectOption value="name">Name</SelectOption><SelectOption value="status">Status</SelectOption><SelectOption value="creditLimit">Credit limit</SelectOption><SelectOption value="createdAt">Date added</SelectOption>
              </Select>
              <Button variant="outline" onClick={() => setSortDirection((value) => value === 'asc' ? 'desc' : 'asc')}>{sortDirection === 'asc' ? 'Ascending' : 'Descending'}</Button>
            </div>
          </div>
          {loading ? <p className="py-8 text-center text-sm text-muted-foreground">Loading customers…</p> : sorted.length === 0 ? (
            <EmptyState title="No customers found" body="Adjust your filters or add a customer profile." />
          ) : (
            <Table>
              <thead><tr><Th>Customer</Th><Th>Status</Th><Th>Credit limit</Th><Th>Risk</Th><Th>Tax ID</Th><Th>Added</Th></tr></thead>
              <tbody>{sorted.map((customer) => <tr key={customer.id}>
                <Td><Link className="font-medium text-navy-700 hover:underline" href={`/customers/${customer.id}`}>{customer.party.displayName}</Link><div className="font-mono text-xs text-muted-foreground">{customer.party.code}</div></Td>
                <Td><div className="flex flex-col items-start gap-1"><Badge tone={tones[customer.status] ?? 'neutral'}>{customer.status.replaceAll('_', ' ')}</Badge>{customer.masterDataStatus !== 'ACTIVE' && <Badge tone="warning">Approval pending</Badge>}</div></Td>
                <Td className="font-mono tabular-nums">{formatAmount(Number(customer.creditLimit), customer.currencyCode)}</Td>
                <Td><Badge tone={customer.riskLevel === 'CRITICAL' || customer.riskLevel === 'HIGH' ? 'danger' : 'neutral'}>{customer.riskLevel}</Badge></Td>
                <Td>{customer.party.taxIdentifier ?? '—'}</Td>
                <Td>{formatDate(customer.createdAt)}</Td>
              </tr>)}</tbody>
            </Table>
          )}
          <div className="mt-4 flex items-center justify-between text-sm">
            <span>{total} customers · page {page} of {totalPages}</span>
            <div className="flex gap-2"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</Button><Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>Next</Button></div>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
