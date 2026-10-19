'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardBody, Table, Th, Td, Badge, Button, Input, EmptyState, Alert } from '@/components/ui';
import { formatAmount, formatDate, shortId } from '@/lib/format';

type JournalEntry = {
  id: string;
  number: string | null;
  status: string;
  createdAt: string;
  period: { code: string } | null;
  balance: { debits: number };
};

export default function JournalEntriesClient() {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [periods, setPeriods] = useState<any[]>([]);
  const [filters, setFilters] = useState({
    periodId: '', status: '', startDate: '', endDate: ''
  });

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    try {
      const res = await fetch(`/api/v1/journal-entries?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch journal entries');
      const json = await res.json();
      setEntries(json.data || []);
      setTotal(json.total || 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    fetch('/api/v1/periods').then(r => r.json()).then(d => setPeriods(d.data || [])).catch(() => {});
    fetchEntries();
  }, [fetchEntries]);

  if (loading && entries.length === 0) return <Card><CardBody className="py-12 text-center text-muted-foreground">Loading...</CardBody></Card>;
  if (error) return <Alert tone="danger" title="Error">{error}</Alert>;

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
          actions={<Button variant="outline" size="sm" onClick={() => setIsFilterOpen(!isFilterOpen)}>{isFilterOpen ? 'Hide Filters' : 'Show Filters'}</Button>}
        />
        {isFilterOpen && (
          <CardBody className="border-t border-border-subtle">
            <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Period</label>
                <select className="border-border-strong h-9 w-full rounded-md border bg-white px-3 text-sm" value={filters.periodId} onChange={(e) => setFilters({...filters, periodId: e.target.value})}>
                  <option value="">All Periods</option>
                  {periods.map((p: any) => <option key={p.id} value={p.id}>{p.code}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Status</label>
                <select className="border-border-strong h-9 w-full rounded-md border bg-white px-3 text-sm" value={filters.status} onChange={(e) => setFilters({...filters, status: e.target.value})}>
                  <option value="">All Statuses</option>
                  <option value="DRAFT">DRAFT</option>
                  <option value="SUBMITTED">SUBMITTED</option>
                  <option value="APPROVED">APPROVED</option>
                  <option value="POSTED">POSTED</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Start Date</label>
                <Input type="date" value={filters.startDate} onChange={(e) => setFilters({...filters, startDate: e.target.value})} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">End Date</label>
                <Input type="date" value={filters.endDate} onChange={(e) => setFilters({...filters, endDate: e.target.value})} />
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setFilters({ periodId: '', status: '', startDate: '', endDate: '' })}>Reset</Button>
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
                    <Td><Badge tone={entry.status === 'POSTED' ? 'success' : entry.status === 'DRAFT' ? 'neutral' : 'info'}>{entry.status}</Badge></Td>
                    <Td className="tabular text-right font-medium">{formatAmount(entry.balance?.debits || 0)}</Td>
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
