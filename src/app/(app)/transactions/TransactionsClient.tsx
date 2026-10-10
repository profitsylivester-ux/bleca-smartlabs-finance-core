'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Card, CardHeader, CardBody, Table, Th, Td, Badge, Button, Input, EmptyState, Alert } from '@/components/ui';
import { formatAmount, formatDate, shortId } from '@/lib/format';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

type Transaction = {
  id: string;
  status: string | null;
  date: string;
  description: string | null;
  reference: string | null;
  amount: number;
  currencyCode: string;
  paymentMethod: string;
  accountId: string | null;
  projectId: string | null;
  departmentId: string | null;
  costCentreId: string | null;
  fundingSourceId: string | null;
  supportingDocumentId: string | null;
  createdAt: string;
  updatedAt: string;
  account?: { id: string; code: string; name: string } | null;
  project?: { id: string; code: string; name: string } | null;
  department?: { id: string; code: string; name: string } | null;
  costCentre?: { id: string; code: string; name: string } | null;
  fundingSource?: { id: string; code: string; name: string } | null;
};

type Actor = {
  roleCodes: string[];
};

function getStatusTone(status: string | null): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'DRAFT':
      return 'neutral';
    case 'SUBMITTED':
      return 'info';
    case 'APPROVED':
      return 'warning';
    case 'POSTED':
    case 'LOCKED':
      return 'success';
    case 'ADJUSTED':
      return 'info';
    case 'REVERSED':
      return 'info';
    case 'REJECTED':
    case 'CANCELLED':
      return 'danger';
    default:
      return 'neutral';
  }
}

function canAdjust(status: string | null): boolean {
  return status === 'POSTED' || status === 'LOCKED';
}

function canReverse(status: string | null): boolean {
  return status === 'POSTED' || status === 'LOCKED';
}

export default function TransactionsClient({ actor }: { actor: Actor }) {
  const searchParams = useSearchParams();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' }>({ key: 'date', direction: 'desc' });

  const hasCreatePermission = useMemo(() => actor.roleCodes.includes('TRANSACTIONS.CREATE'), [actor.roleCodes]);

  const initialFilters = useMemo(() => ({
    status: searchParams.get('status') || '',
    projectId: searchParams.get('projectId') || '',
    departmentId: searchParams.get('departmentId') || '',
    costCentreId: searchParams.get('costCentreId') || '',
    fundingSourceId: searchParams.get('fundingSourceId') || '',
    accountId: searchParams.get('accountId') || '',
    minAmount: searchParams.get('minAmount') || '',
    maxAmount: searchParams.get('maxAmount') || '',
    startDate: searchParams.get('startDate') || '',
    endDate: searchParams.get('endDate') || '',
    search: searchParams.get('search') || '',
  }), [searchParams]);

  const [filters, setFilters] = useState(initialFilters);

  const fetchTransactions = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));
    params.set('sortBy', sortConfig.key);
    params.set('sortOrder', sortConfig.direction);

    Object.entries(filters).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });

    try {
      const res = await fetch(`/api/v1/transactions?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch transactions');
      const json = await res.json();
      setTransactions(json.data);
      setTotal(json.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, filters, sortConfig]);

  const fetchRef = useRef(fetchTransactions);
  useEffect(() => {
    fetchRef.current = fetchTransactions;
  }, [fetchTransactions]);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchRef.current();
    }, 0);
    return () => clearTimeout(timer);
  }, [fetchTransactions]);

  const handleFilterChange = (key: string, value: string) => {
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

  const handleExport = async () => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    params.set('export', 'csv');
    try {
      const res = await fetch(`/api/v1/transactions?${params.toString()}`);
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `transactions-${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    }
  };

  const sortedTransactions = useMemo(() => {
    return [...transactions].sort((a, b) => {
      const aVal = a[sortConfig.key as keyof Transaction];
      const bVal = b[sortConfig.key as keyof Transaction];
      if (aVal === null || aVal === undefined) return 1;
      if (bVal === null || bVal === undefined) return -1;
      const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return sortConfig.direction === 'asc' ? cmp : -cmp;
    });
  }, [transactions, sortConfig]);

  const totalPages = Math.ceil(total / pageSize);

  if (loading) {
    return (
      <Card>
        <CardBody className="py-12">
          <div className="text-center text-muted-foreground">Loading transactions…</div>
        </CardBody>
      </Card>
    );
  }

  if (error) {
    return <Alert tone="danger" title="Failed to load transactions">{error}</Alert>;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Filters"
          description="Filter transactions by status, date range, dimensions, and amount."
          actions={
            <Button variant="outline" size="sm" onClick={handleExport} disabled={transactions.length === 0}>
              Export CSV
            </Button>
          }
        />
        <CardBody>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
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
                <option value="ADJUSTED">ADJUSTED</option>
                <option value="REVERSED">REVERSED</option>
                <option value="REJECTED">REJECTED</option>
                <option value="CANCELLED">CANCELLED</option>
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
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Min Amount</label>
              <Input
                type="number"
                step="0.01"
                placeholder="Min"
                value={filters.minAmount}
                onChange={(e) => handleFilterChange('minAmount', e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Max Amount</label>
              <Input
                type="number"
                step="0.01"
                placeholder="Max"
                value={filters.maxAmount}
                onChange={(e) => handleFilterChange('maxAmount', e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Search</label>
              <Input
                type="text"
                placeholder="Description/Ref"
                value={filters.search}
                onChange={(e) => handleFilterChange('search', e.target.value)}
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
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Funding Source ID</label>
              <Input
                type="text"
                placeholder="Funding Source ID"
                value={filters.fundingSourceId}
                onChange={(e) => handleFilterChange('fundingSourceId', e.target.value)}
              />
            </div>
          </div>
          <div className="mt-3">
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Account ID</label>
            <Input
              type="text"
              placeholder="Account ID"
              value={filters.accountId}
              onChange={(e) => handleFilterChange('accountId', e.target.value)}
            />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Transactions"
          description={`${total} transactions found`}
          actions={
            hasCreatePermission ? (
              <Link href="/transactions/new">
                <Button size="sm">New Transaction</Button>
              </Link>
            ) : null
          }
        />
        <CardBody>
          {sortedTransactions.length === 0 ? (
            <EmptyState title="No transactions found" body="Adjust your filters or create a new transaction." />
          ) : (
            <div className="space-y-4">
              <Table>
                <thead>
                  <tr>
                    <Th onClick={() => handleSort('date')} className="cursor-pointer select-none">
                      Date {sortConfig.key === 'date' && (sortConfig.direction === 'asc' ? ' ↑' : ' ↓')}
                    </Th>
                    <Th onClick={() => handleSort('reference')} className="cursor-pointer select-none">
                      Reference {sortConfig.key === 'reference' && (sortConfig.direction === 'asc' ? ' ↑' : ' ↓')}
                    </Th>
                    <Th>Description</Th>
                    <Th onClick={() => handleSort('status')} className="cursor-pointer select-none">
                      Status {sortConfig.key === 'status' && (sortConfig.direction === 'asc' ? ' ↑' : ' ↓')}
                    </Th>
                    <Th>Account</Th>
                    <Th>Project</Th>
                    <Th>Department</Th>
                    <Th onClick={() => handleSort('amount')} className="cursor-pointer select-none">
                      Amount {sortConfig.key === 'amount' && (sortConfig.direction === 'asc' ? ' ↑' : ' ↓')}
                    </Th>
                    <Th>Payment Method</Th>
                    <Th>Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {sortedTransactions.map((tx) => (
                    <tr key={tx.id}>
                      <Td>{formatDate(tx.date)}</Td>
                      <Td>
                        <Link href={`/transactions/${tx.id}`} className="text-navy-600 hover:underline">
                          {tx.reference ?? shortId(tx.id)}
                        </Link>
                      </Td>
                      <Td className="max-w-xs truncate">{tx.description ?? '-'}</Td>
                      <Td>
                        <Badge tone={getStatusTone(tx.status)}>{tx.status ?? 'DRAFT'}</Badge>
                      </Td>
                      <Td>{tx.account?.code ?? tx.accountId ?? '-'}</Td>
                      <Td>{tx.project?.code ?? tx.projectId ?? '-'}</Td>
                      <Td>{tx.department?.code ?? tx.departmentId ?? '-'}</Td>
                      <Td>{formatAmount(tx.amount, tx.currencyCode)}</Td>
                      <Td>{tx.paymentMethod}</Td>
                      <Td>
                        <div className="flex items-center gap-2">
                          <Link href={`/transactions/${tx.id}`} className="text-navy-600 hover:underline text-sm">
                            View
                          </Link>
                          {canAdjust(tx.status) && (
                            <Link href={`/transactions/${tx.id}/adjust`} className="text-navy-600 hover:underline text-sm">
                              Adjust
                            </Link>
                          )}
                          {canReverse(tx.status) && (
                            <Link href={`/transactions/${tx.id}/reverse`} className="text-navy-600 hover:underline text-sm">
                              Reverse
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