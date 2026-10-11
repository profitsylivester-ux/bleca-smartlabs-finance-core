'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Card, CardHeader, CardBody, Table, Th, Td, Badge, Button, Input, EmptyState, Alert, Select, SelectOption } from '@/components/ui';
import { formatDate, formatAmount } from '@/lib/format';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

type PaymentSchedule = {
  id: string;
  code: string;
  description: string | null;
  amount: number;
  currencyCode: string;
  frequency: string;
  nextDueDate: string;
  endDate: string | null;
  status: string;
  treasuryAccountId: string;
  treasuryAccount: { id: string; code: string; name: string; kind: string } | null;
  createdAt: string;
  updatedAt: string;
};

type Actor = {
  roleCodes: string[];
};

function getStatusTone(status: string): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'SCHEDULED':
      return 'info';
    case 'DUE':
      return 'warning';
    case 'PARTIALLY_PAID':
      return 'warning';
    case 'PAID':
      return 'success';
    case 'OVERDUE':
      return 'danger';
    case 'CANCELLED':
      return 'neutral';
    default:
      return 'neutral';
  }
}

function getFrequencyTone(freq: string): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  switch (freq) {
    case 'DAILY':
      return 'danger';
    case 'WEEKLY':
      return 'warning';
    case 'MONTHLY':
      return 'info';
    case 'QUARTERLY':
      return 'success';
    case 'ANNUALLY':
      return 'neutral';
    case 'CUSTOM':
      return 'neutral';
    default:
      return 'neutral';
  }
}

export default function PaymentSchedulesClient({ actor }: { actor: Actor }) {
  const searchParams = useSearchParams();
  const [schedules, setSchedules] = useState<PaymentSchedule[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' }>({ key: 'nextDueDate', direction: 'asc' });

  const hasCreatePermission = useMemo(() => actor.roleCodes.includes('TREASURY_TRANSFERS.CREATE'), [actor.roleCodes]);
  const hasEditPermission = useMemo(() => actor.roleCodes.includes('TREASURY_TRANSFERS.EDIT'), [actor.roleCodes]);

  const initialFilters = useMemo(() => ({
    status: searchParams.get('status') || '',
    treasuryAccountId: searchParams.get('treasuryAccountId') || '',
    overdueOnly: searchParams.get('overdueOnly') === 'true',
    search: searchParams.get('search') || '',
  }), [searchParams]);

  const [filters, setFilters] = useState(initialFilters);

  const fetchSchedules = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));
    params.set('sortBy', sortConfig.key);
    params.set('sortOrder', sortConfig.direction);

    Object.entries(filters).forEach(([key, value]) => {
      if (value !== '' && value !== false && value !== undefined && value !== null) {
        params.set(key, String(value));
      }
    });

    try {
      const res = await fetch(`/api/v1/payment-schedules?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch payment schedules');
      const json = await res.json();
      setSchedules(json.data);
      setTotal(json.count);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, filters, sortConfig]);

  const fetchRef = useRef(fetchSchedules);
  useEffect(() => {
    fetchRef.current = fetchSchedules;
  }, [fetchSchedules]);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchRef.current();
    }, 0);
    return () => clearTimeout(timer);
  }, [fetchSchedules]);

  const handleFilterChange = (key: string, value: string | boolean) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1);
  };

  const handleSort = (key: string) => {
    setSortConfig((prev) => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc',
    }));
    setPage(1);
  };

  const handlePageChange = (newPage: number) => {
    setPage(newPage);
  };

  const sortedSchedules = useMemo(() => {
    return [...schedules].sort((a, b) => {
      const aVal = a[sortConfig.key as keyof PaymentSchedule];
      const bVal = b[sortConfig.key as keyof PaymentSchedule];
      if (aVal === null || aVal === undefined) return 1;
      if (bVal === null || bVal === undefined) return -1;
      const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return sortConfig.direction === 'asc' ? cmp : -cmp;
    });
  }, [schedules, sortConfig]);

  const totalPages = Math.ceil(total / pageSize);

  if (loading) {
    return (
      <Card>
        <CardBody className="py-12">
          <div className="text-center text-muted-foreground">Loading payment schedules…</div>
        </CardBody>
      </Card>
    );
  }

  if (error) {
    return <Alert tone="danger" title="Failed to load payment schedules">{error}</Alert>;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Filters"
          description="Filter payment schedules by status, treasury account, and search term."
        />
        <CardBody>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Status</label>
              <Select value={filters.status} onChange={(e) => handleFilterChange('status', e.target.value)}>
                <SelectOption value="">All</SelectOption>
                <SelectOption value="SCHEDULED">Scheduled</SelectOption>
                <SelectOption value="DUE">Due</SelectOption>
                <SelectOption value="PARTIALLY_PAID">Partially Paid</SelectOption>
                <SelectOption value="PAID">Paid</SelectOption>
                <SelectOption value="OVERDUE">Overdue</SelectOption>
                <SelectOption value="CANCELLED">Cancelled</SelectOption>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Treasury Account</label>
              <Input
                type="text"
                placeholder="Account ID"
                value={filters.treasuryAccountId}
                onChange={(e) => handleFilterChange('treasuryAccountId', e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Search</label>
              <Input
                type="text"
                placeholder="Code/Description"
                value={filters.search}
                onChange={(e) => handleFilterChange('search', e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Overdue Only</label>
              <select
                className="border-border-strong text-foreground h-9 w-full rounded-md border bg-white px-3 text-sm"
                value={filters.overdueOnly ? 'true' : 'false'}
                onChange={(e) => handleFilterChange('overdueOnly', e.target.value === 'true' ? 'true' : 'false')}
              >
                <option value="false">No</option>
                <option value="true">Yes</option>
              </select>
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Payment Schedules"
          description={`${total} schedules found`}
          actions={
            hasCreatePermission ? (
              <Link href="/treasury/payment-schedules/new">
                <Button size="sm">New Schedule</Button>
              </Link>
            ) : null
          }
        />
        <CardBody>
          {sortedSchedules.length === 0 ? (
            <EmptyState title="No payment schedules found" body="Adjust your filters or create a new schedule." />
          ) : (
            <div className="space-y-4">
              <Table>
                <thead>
                  <tr>
                    <Th onClick={() => handleSort('code')} className="cursor-pointer select-none">
                      Code {sortConfig.key === 'code' && (sortConfig.direction === 'asc' ? ' ↑' : ' ↓')}
                    </Th>
                    <Th>Description</Th>
                    <Th onClick={() => handleSort('amount')} className="cursor-pointer select-none">
                      Amount {sortConfig.key === 'amount' && (sortConfig.direction === 'asc' ? ' ↑' : ' ↓')}
                    </Th>
                    <Th>Currency</Th>
                    <Th onClick={() => handleSort('frequency')} className="cursor-pointer select-none">
                      Frequency {sortConfig.key === 'frequency' && (sortConfig.direction === 'asc' ? ' ↑' : ' ↓')}
                    </Th>
                    <Th onClick={() => handleSort('nextDueDate')} className="cursor-pointer select-none">
                      Next Due {sortConfig.key === 'nextDueDate' && (sortConfig.direction === 'asc' ? ' ↑' : ' ↓')}
                    </Th>
                    <Th>End Date</Th>
                    <Th onClick={() => handleSort('status')} className="cursor-pointer select-none">
                      Status {sortConfig.key === 'status' && (sortConfig.direction === 'asc' ? ' ↑' : ' ↓')}
                    </Th>
                    <Th>Treasury Account</Th>
                    <Th>Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {sortedSchedules.map((schedule) => (
                    <tr key={schedule.id}>
                      <Td>
                        <Link href={`/treasury/payment-schedules/${schedule.id}`} className="text-navy-600 hover:underline font-mono">
                          {schedule.code}
                        </Link>
                      </Td>
                      <Td className="max-w-xs truncate">{schedule.description || '—'}</Td>
                      <Td className="font-mono tabular-nums">{formatAmount(schedule.amount, schedule.currencyCode)}</Td>
                      <Td>{schedule.currencyCode}</Td>
                      <Td>
                        <Badge tone={getFrequencyTone(schedule.frequency)}>{schedule.frequency}</Badge>
                      </Td>
                      <Td className="font-mono text-sm">{formatDate(schedule.nextDueDate)}</Td>
                      <Td className="font-mono text-sm">{schedule.endDate ? formatDate(schedule.endDate) : '—'}</Td>
                      <Td>
                        <Badge tone={getStatusTone(schedule.status)}>{schedule.status}</Badge>
                      </Td>
                      <Td>
                        {schedule.treasuryAccount ? (
                          <Link href={`/treasury/accounts/${schedule.treasuryAccount.id}`} className="text-navy-600 hover:underline text-sm">
                            {schedule.treasuryAccount.code} - {schedule.treasuryAccount.name}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </Td>
                      <Td>
                        <div className="flex items-center gap-2">
                          <Link href={`/treasury/payment-schedules/${schedule.id}`} className="text-navy-600 hover:underline text-sm">
                            View
                          </Link>
                          {hasEditPermission && (
                            <Link href={`/treasury/payment-schedules/${schedule.id}/edit`} className="text-navy-600 hover:underline text-sm">
                              Edit
                            </Link>
                          )}
                        </div>
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