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
      <Card>
        <CardHeader title="Filters" description="Filter journal entries by period, status, type, date range and dimensions." />
        <CardBody>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Period</label>
              <Input
                type="text"
                placeholder="Period ID"
                value={filters.periodId}
                onChange={(e) => handleFilterChange('periodId', e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Status</label>
              <select
                className="border-border-strong text-foreground h-9 w-full rounded-md border bg-white px-3 text-sm"
                value={filters.status}
                onChange={(e) => handleFilterChange('status', e.target.value)}
              >
                <option value="">All</option>
                <option value="DRAFT">DRAFT</option>
                <option value="SUBMITTED">SUBMITTED</option>
                <option value="APPROVED">APPROVED</option>
                <option value="POSTED">POSTED</option>
                <option value="LOCKED">LOCKED</option>
                <option value="REVERSED">REVERSED</option>
                <option value="VOIDED">VOIDED</option>
                <option value="REJECTED">REJECTED</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Type</label>
              <select
                className="border-border-strong text-foreground h-9 w-full rounded-md border bg-white px-3 text-sm"
                value={filters.type}
                onChange={(e) => handleFilterChange('type', e.target.value)}
              >
                <option value="">All</option>
                <option value="STANDARD">STANDARD</option>
                <option value="OPENING_BALANCE">OPENING_BALANCE</option>
                <option value="ADJUSTMENT">ADJUSTMENT</option>
                <option value="REVERSAL">REVERSAL</option>
                <option value="CORRECTION">CORRECTION</option>
                <option value="CLOSING">CLOSING</option>
                <option value="SYSTEM">SYSTEM</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Start Date</label>
              <Input
                type="date"
                value={filters.startDate}
                onChange={(e) => handleFilterChange('startDate', e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">End Date</label>
              <Input
                type="date"
                value={filters.endDate}
                onChange={(e) => handleFilterChange('endDate', e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Account ID</label>
              <Input
                type="text"
                placeholder="Account ID"
                value={filters.accountId}
                onChange={(e) => handleFilterChange('accountId', e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Project ID</label>
              <Input
                type="text"
                placeholder="Project ID"
                value={filters.projectId}
                onChange={(e) => handleFilterChange('projectId', e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Department ID</label>
              <Input
                type="text"
                placeholder="Department ID"
                value={filters.departmentId}
                onChange={(e) => handleFilterChange('departmentId', e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Cost Centre ID</label>
              <Input
                type="text"
                placeholder="Cost Centre ID"
                value={filters.costCentreId}
                onChange={(e) => handleFilterChange('costCentreId', e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Location ID</label>
              <Input
                type="text"
                placeholder="Location ID"
                value={filters.locationId}
                onChange={(e) => handleFilterChange('locationId', e.target.value)}
              />
            </div>
          </div>
          <div className="mt-3">
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Funding Source ID</label>
            <Input
              type="text"
              placeholder="Funding Source ID"
              value={filters.fundingSourceId}
              onChange={(e) => handleFilterChange('fundingSourceId', e.target.value)}
            />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Journal Entries" description={`${total} entries found`} />
        <CardBody>
          {entries.length === 0 ? (
            <EmptyState title="No journal entries found" body="Adjust your filters or create a new journal entry." />
          ) : (
            <div className="space-y-4">
              <Table>
                <thead>
                  <tr>
                    <Th>Number</Th>
                    <Th>Type</Th>
                    <Th>Status</Th>
                    <Th>Period</Th>
                    <Th>Reference</Th>
                    <Th>Debits</Th>
                    <Th>Credits</Th>
                    <Th>Balance</Th>
                    <Th>Posted At</Th>
                    <Th>Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.id}>
                      <Td>
                        <Link href={`/accounting/journal-entries/${entry.id}`} className="text-navy-600 hover:underline">
                          {entry.number ?? shortId(entry.id)}
                        </Link>
                      </Td>
                      <Td>{entry.type}</Td>
                      <Td>
                        <Badge tone={getStatusTone(entry.status)}>{entry.status}</Badge>
                      </Td>
                      <Td>{entry.period?.code ?? '-'}</Td>
                      <Td>{entry.reference ?? '-'}</Td>
                      <Td>{formatAmount(entry.balance.debits)}</Td>
                      <Td>{formatAmount(entry.balance.credits)}</Td>
                      <Td>
                        <Badge tone={entry.balance.balanced ? 'success' : 'danger'}>
                          {entry.balance.balanced ? 'Balanced' : `Diff: ${formatAmount(entry.balance.difference)}`}
                        </Badge>
                      </Td>
                      <Td>{entry.postedAt ? formatDate(entry.postedAt) : '-'}</Td>
                      <Td>
                        <Link href={`/accounting/journal-entries/${entry.id}`} className="text-navy-600 hover:underline text-sm">
                          View
                        </Link>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              {totalPages > 1 && (
                <div className="mt-4 flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">
                    Page {page} of {totalPages} ({total} total)
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page === 1}
                      onClick={() => handlePageChange(page - 1)}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page === totalPages}
                      onClick={() => handlePageChange(page + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}