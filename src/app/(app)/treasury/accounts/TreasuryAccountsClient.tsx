'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Card, CardHeader, CardBody, Table, Th, Td, Badge, Button, Input, EmptyState, Alert } from '@/components/ui';
import { formatDate, shortId } from '@/lib/format';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

type TreasuryAccount = {
  id: string;
  code: string;
  name: string;
  kind: string;
  currencyCode: string;
  ledgerAccountId: string;
  locationId: string | null;
  fundingSourceId: string | null;
  isActive: boolean;
  isRestricted: boolean;
  createdAt: string;
  updatedAt: string;
  _count?: {
    journalLines: number;
    transactions: number;
    paymentSchedules: number;
  };
};

type Actor = {
  roleCodes: string[];
};

function getKindTone(kind: string): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  switch (kind) {
    case 'CASH':
      return 'success';
    case 'BANK':
      return 'info';
    case 'MOBILE_MONEY':
      return 'warning';
    case 'PAYMENT_GATEWAY':
      return 'info';
    case 'PROJECT_FUND':
      return 'neutral';
    case 'GRANT_FUND':
      return 'warning';
    case 'OTHER':
      return 'neutral';
    default:
      return 'neutral';
  }
}

export default function TreasuryAccountsClient({ actor }: { actor: Actor }) {
  const searchParams = useSearchParams();
  const [accounts, setAccounts] = useState<TreasuryAccount[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' }>({ key: 'code', direction: 'asc' });

  const hasCreatePermission = useMemo(() => actor.roleCodes.includes('TREASURY_TRANSFERS.CREATE'), [actor.roleCodes]);
  const hasEditPermission = useMemo(() => actor.roleCodes.includes('TREASURY_TRANSFERS.EDIT'), [actor.roleCodes]);

  const initialFilters = useMemo(() => ({
    kind: searchParams.get('kind') || '',
    isActive: searchParams.get('isActive') || '',
    search: searchParams.get('search') || '',
  }), [searchParams]);

  const [filters, setFilters] = useState(initialFilters);

  const fetchAccounts = useCallback(async () => {
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
      const res = await fetch(`/api/v1/treasury-accounts?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch treasury accounts');
      const json = await res.json();
      setAccounts(json.data);
      setTotal(json.count);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, filters, sortConfig]);

  const fetchRef = useRef(fetchAccounts);
  useEffect(() => {
    fetchRef.current = fetchAccounts;
  }, [fetchAccounts]);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchRef.current();
    }, 0);
    return () => clearTimeout(timer);
  }, [fetchAccounts]);

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

  const sortedAccounts = useMemo(() => {
    return [...accounts].sort((a, b) => {
      const aVal = a[sortConfig.key as keyof TreasuryAccount];
      const bVal = b[sortConfig.key as keyof TreasuryAccount];
      if (aVal === null || aVal === undefined) return 1;
      if (bVal === null || bVal === undefined) return -1;
      const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return sortConfig.direction === 'asc' ? cmp : -cmp;
    });
  }, [accounts, sortConfig]);

  const totalPages = Math.ceil(total / pageSize);

  if (loading) {
    return (
      <Card>
        <CardBody className="py-12">
          <div className="text-center text-muted-foreground">Loading treasury accounts…</div>
        </CardBody>
      </Card>
    );
  }

  if (error) {
    return <Alert tone="danger" title="Failed to load treasury accounts">{error}</Alert>;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Filters"
          description="Filter treasury accounts by kind, status, and search term."
          actions={
            <Button variant="outline" size="sm" onClick={() => { /* export logic */ }} disabled={accounts.length === 0}>
              Export CSV
            </Button>
          }
        />
        <CardBody>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Kind</label>
              <select
                className="border-border-strong text-foreground h-9 w-full rounded-md border bg-white px-3 text-sm"
                value={filters.kind}
                onChange={(e) => handleFilterChange('kind', e.target.value)}
              >
                <option value="">All</option>
                <option value="CASH">Cash</option>
                <option value="BANK">Bank</option>
                <option value="MOBILE_MONEY">Mobile Money</option>
                <option value="PAYMENT_GATEWAY">Payment Gateway</option>
                <option value="PROJECT_FUND">Project Fund</option>
                <option value="GRANT_FUND">Grant Fund</option>
                <option value="OTHER">Other</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Status</label>
              <select
                className="border-border-strong text-foreground h-9 w-full rounded-md border bg-white px-3 text-sm"
                value={filters.isActive}
                onChange={(e) => handleFilterChange('isActive', e.target.value)}
              >
                <option value="">All</option>
                <option value="true">Active</option>
                <option value="false">Inactive</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Search</label>
              <Input
                type="text"
                placeholder="Code/Name"
                value={filters.search}
                onChange={(e) => handleFilterChange('search', e.target.value)}
              />
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Treasury Accounts"
          description={`${total} accounts found`}
          actions={
            hasCreatePermission ? (
              <Link href="/treasury/accounts/new">
                <Button size="sm">New Account</Button>
              </Link>
            ) : null
          }
        />
        <CardBody>
          {sortedAccounts.length === 0 ? (
            <EmptyState title="No treasury accounts found" body="Adjust your filters or create a new account." />
          ) : (
            <div className="space-y-4">
              <Table>
                <thead>
                  <tr>
                    <Th onClick={() => handleSort('code')} className="cursor-pointer select-none">
                      Code {sortConfig.key === 'code' && (sortConfig.direction === 'asc' ? ' ↑' : ' ↓')}
                    </Th>
                    <Th>Name</Th>
                    <Th onClick={() => handleSort('kind')} className="cursor-pointer select-none">
                      Kind {sortConfig.key === 'kind' && (sortConfig.direction === 'asc' ? ' ↑' : ' ↓')}
                    </Th>
                    <Th>Currency</Th>
                    <Th onClick={() => handleSort('isActive')} className="cursor-pointer select-none">
                      Status {sortConfig.key === 'isActive' && (sortConfig.direction === 'asc' ? ' ↑' : ' ↓')}
                    </Th>
                    <Th>Restricted</Th>
                    <Th>Ledger Account</Th>
                    <Th>Lines</Th>
                    <Th>Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {sortedAccounts.map((account) => (
                    <tr key={account.id}>
                      <Td>
                        <Link href={`/treasury/accounts/${account.id}`} className="text-navy-600 hover:underline font-mono">
                          {account.code}
                        </Link>
                      </Td>
                      <Td className="max-w-xs truncate">{account.name}</Td>
                      <Td>
                        <Badge tone={getKindTone(account.kind)}>{account.kind.replace('_', ' ')}</Badge>
                      </Td>
                      <Td>{account.currencyCode}</Td>
                      <Td>
                        <Badge tone={account.isActive ? 'success' : 'neutral'}>{account.isActive ? 'Active' : 'Inactive'}</Badge>
                      </Td>
                      <Td>
                        <Badge tone={account.isRestricted ? 'warning' : 'neutral'}>{account.isRestricted ? 'Yes' : 'No'}</Badge>
                      </Td>
                      <Td className="font-mono text-sm">{shortId(account.ledgerAccountId)}</Td>
                      <Td className="text-sm text-muted-foreground">
                        {account._count?.journalLines ?? 0} / {account._count?.transactions ?? 0}
                      </Td>
                      <Td>
                        <div className="flex items-center gap-2">
                          <Link href={`/treasury/accounts/${account.id}`} className="text-navy-600 hover:underline text-sm">
                            View
                          </Link>
                          {hasEditPermission && (
                            <Link href={`/treasury/accounts/${account.id}/edit`} className="text-navy-600 hover:underline text-sm">
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