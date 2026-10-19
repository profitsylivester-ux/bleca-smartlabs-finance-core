'use client';

/* eslint-disable react-hooks/set-state-in-effect */
import { useState, useEffect, useCallback } from 'react';
import { Card, CardHeader, CardBody, Table, Th, Td, Badge, Button, Input, EmptyState, Alert } from '@/components/ui';
import { formatAmount, formatDate, shortId } from '@/lib/format';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

type JournalEntry = {
  id: string;
  number: string | null;
  type: string;
  status: string;
  source: string;
  reference: string | null;
  description: string | null;
  postedAt: string | null;
  createdAt: string;
  period: { id: string; code: string; name: string; status: string } | null;
  lines: Array<{
    id: string;
    accountId: string;
    lineNumber: number;
    debit: number | string;
    credit: number | string;
    currencyCode: string;
    baseAmount: number | string;
    fxRate: number | string | null;
    projectId: string | null;
    departmentId: string | null;
    costCentreId: string | null;
    locationId: string | null;
    fundingSourceId: string | null;
    account: { id: string; code: string; name: string } | null;
  }>;
  submittedBy: { id: string; fullName: string } | null;
  approvedBy: { id: string; fullName: string } | null;
  postedBy: { id: string; fullName: string } | null;
  balance: { debits: number; credits: number; balanced: boolean; difference: number };
};

function getStatusTone(status: string): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'DRAFT':
      return 'neutral';
    case 'SUBMITTED':
      return 'info';
    case 'APPROVED':
      return 'warning';
    case 'POSTED':
      return 'success';
    case 'LOCKED':
      return 'success';
    case 'REVERSED':
      return 'info';
    case 'VOIDED':
      return 'danger';
    case 'REJECTED':
      return 'danger';
    default:
      return 'neutral';
  }
}

export default function JournalEntriesClient() {
  const searchParams = useSearchParams();
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const [loading, setLoading] = useState(true);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [periods, setPeriods] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState({
    periodId: searchParams.get('periodId') || '',
    status: searchParams.get('status') || '',
    type: searchParams.get('type') || '',
    startDate: searchParams.get('startDate') || '',
    endDate: searchParams.get('endDate') || '',
    accountId: searchParams.get('accountId') || '',
    projectId: searchParams.get('projectId') || '',
    departmentId: searchParams.get('departmentId') || '',
    costCentreId: searchParams.get('costCentreId') || '',
    locationId: searchParams.get('locationId') || '',
    fundingSourceId: searchParams.get('fundingSourceId') || '',
  });

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));
    Object.entries(filters).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    try {
      const res = await fetch(`/api/v1/journal-entries?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch journal entries');
      const json = await res.json();
      setEntries(json.data);
      setTotal(json.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, filters]);

  useEffect(() => {
    fetch('/api/v1/periods').then(r => r.json()).then(d => setPeriods(d.data || [])).catch(() => {});
  }, []);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  const handleFilterChange = (key: string, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1);
  };

  const handlePageChange = (newPage: number) => {
    setPage(newPage);
  };

  if (loading) {
    return (
      <Card>
        <CardBody className="py-12">
          <div className="text-center text-muted-foreground">Loading journal entries…</div>
        </CardBody>
      </Card>
    );
  }

  if (error) {
    return <Alert tone="danger" title="Failed to load journal entries">{error}</Alert>;
  }

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Journal Entries</h2>
        <Link href="/accounting/journal-entries/new" className="bg-navy-800 rounded-md px-4 py-2 text-sm font-medium text-white hover:bg-navy-700">
          + New Journal Entry
        </Link>
      </div>

      <Card>
        <CardHeader 
          title="Search & Filter" 
          description="Click to expand the filters." 
          action={<Button variant="outline" size="sm" onClick={() => setIsFilterOpen(!isFilterOpen)}>{isFilterOpen ? 'Hide Filters' : 'Show Filters'}</Button>}
        />
        {isFilterOpen && (
          <CardBody className="border-t border-border-subtle">
            <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Period</label>
                <select className="border-border-strong h-9 w-full rounded-md border bg-white px-3 text-sm" value={filters.periodId} onChange={(e) => handleFilterChange('periodId', e.target.value)}>
                  <option value="">All Periods</option>
                  {periods.map((p: any) => <option key={p.id} value={p.id}>{p.code}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Status</label>
                <select className="border-border-strong h-9 w-full rounded-md border bg-white px-3 text-sm" value={filters.status} onChange={(e) => handleFilterChange('status', e.target.value)}>
                  <option value="">All Statuses</option>
                  <option value="DRAFT">DRAFT</option>
                  <option value="SUBMITTED">SUBMITTED</option>
                  <option value="APPROVED">APPROVED</option>
                  <option value="POSTED">POSTED</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Start Date</label>
                <Input type="date" value={filters.startDate} onChange={(e) => handleFilterChange('startDate', e.target.value)} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">End Date</label>
                <Input type="date" value={filters.endDate} onChange={(e) => handleFilterChange('endDate', e.target.value)} />
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={() => { setFilters({ periodId: '', status: '', type: '', startDate: '', endDate: '', accountId: '', projectId: '', departmentId: '', costCentreId: '', locationId: '', fundingSourceId: '' }); setPage(1); }}>Reset</Button>
              <Button onClick={() => fetchEntries()}>Apply Filters</Button>
            </div>
          </CardBody>
        )}
      </Card>

      <Card>
        <CardBody className="px-0 py-0">
          {entries.length === 0 ? (
            <EmptyState title="No entries found" body="Try adjusting your filters or create a new entry." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Entry #</Th>
                  <Th>Date</Th>
                  <Th>Period</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Amount</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <Td className="font-medium">{entry.number || shortId(entry.id)}</Td>
                    <Td>{formatDate(entry.createdAt)}</Td>
                    <Td>{entry.period?.code || '—'}</Td>
                    <Td><Badge tone={getStatusTone(entry.status)}>{entry.status}</Badge></Td>
                    <Td className="tabular text-right font-medium">{formatAmount(entry.balance.debits)}</Td>
                    <Td className="text-right">
                      <Link href={`/accounting/journal-entries/${entry.id}`} className="text-navy-600 hover:underline">View</Link>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
}