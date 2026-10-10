'use client';

/* eslint-disable react-hooks/set-state-in-effect */
import { useState, useEffect, useCallback } from 'react';
import { Card, CardHeader, CardBody, Button, Input, Table, Th, Td, Badge, EmptyState, Alert, Label } from '@/components/ui';
import { formatAmount, formatDate, shortId } from '@/lib/format';
import Link from 'next/link';

type JournalLine = {
  id: string;
  entryId: string;
  accountId: string;
  lineNumber: number;
  description: string | null;
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
  account: { id: string; code: string; name: string; type: string } | null;
  entry: {
    id: string;
    number: string | null;
    type: string;
    status: string;
    reference: string | null;
    description: string | null;
    postedAt: string | null;
    period: { id: string; code: string; name: string } | null;
  };
  project: { id: string; code: string; name: string } | null;
  department: { id: string; code: string; name: string } | null;
  costCentre: { id: string; code: string; name: string } | null;
  location: { id: string; code: string; name: string } | null;
  fundingSource: { id: string; code: string; name: string } | null;
  runningBalance: number;
  runningDebit: number;
  runningCredit: number;
};

export default function GeneralLedgerClient() {
  const [lines, setLines] = useState<JournalLine[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState({
    accountId: '',
    periodId: '',
    startDate: '',
    endDate: '',
    projectId: '',
    departmentId: '',
    costCentreId: '',
    locationId: '',
    fundingSourceId: '',
    currency: '',
  });

  const fetchLines = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));
    Object.entries(filters).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    try {
      const res = await fetch(`/api/v1/general-ledger?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch general ledger');
      const json = await res.json();
      setLines(json.data);
      setTotal(json.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [page, filters]);

  useEffect(() => {
    fetchLines();
  }, [fetchLines]);

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
          <div className="text-center text-muted-foreground">Loading general ledger…</div>
        </CardBody>
      </Card>
    );
  }

  if (error) {
    return <Alert tone="danger" title="Failed to load general ledger">{error}</Alert>;
  }

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Filters" description="Filter by account, period, date range, and dimensions." />
        <CardBody>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            <div>
              <Label htmlFor="accountId">Account ID</Label>
              <Input id="accountId" placeholder="Account ID" value={filters.accountId} onChange={(e) => handleFilterChange('accountId', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="periodId">Period ID</Label>
              <Input id="periodId" placeholder="Period ID" value={filters.periodId} onChange={(e) => handleFilterChange('periodId', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="startDate">Start Date</Label>
              <Input id="startDate" type="date" value={filters.startDate} onChange={(e) => handleFilterChange('startDate', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="endDate">End Date</Label>
              <Input id="endDate" type="date" value={filters.endDate} onChange={(e) => handleFilterChange('endDate', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="projectId">Project ID</Label>
              <Input id="projectId" placeholder="Project ID" value={filters.projectId} onChange={(e) => handleFilterChange('projectId', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="departmentId">Department ID</Label>
              <Input id="departmentId" placeholder="Department ID" value={filters.departmentId} onChange={(e) => handleFilterChange('departmentId', e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
            <div>
              <Label htmlFor="costCentreId">Cost Centre ID</Label>
              <Input id="costCentreId" placeholder="Cost Centre ID" value={filters.costCentreId} onChange={(e) => handleFilterChange('costCentreId', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="locationId">Location ID</Label>
              <Input id="locationId" placeholder="Location ID" value={filters.locationId} onChange={(e) => handleFilterChange('locationId', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="fundingSourceId">Funding Source ID</Label>
              <Input id="fundingSourceId" placeholder="Funding Source ID" value={filters.fundingSourceId} onChange={(e) => handleFilterChange('fundingSourceId', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="currency">Currency</Label>
              <Input id="currency" placeholder="TZS" maxLength={3} value={filters.currency} onChange={(e) => handleFilterChange('currency', e.target.value)} />
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="General Ledger" description={`${total} lines found`} />
        <CardBody>
          {lines.length === 0 ? (
            <EmptyState title="No lines found" body="Adjust your filters to see journal lines." />
          ) : (
            <div className="space-y-4">
              <Table>
                <thead>
                  <tr>
                    <Th>Date</Th>
                    <Th>Entry</Th>
                    <Th>Account</Th>
                    <Th>Description</Th>
                    <Th className="text-right">Debit</Th>
                    <Th className="text-right">Credit</Th>
                    <Th className="text-right">Running Balance</Th>
                    <Th>Project</Th>
                    <Th>Department</Th>
                    <Th>Cost Centre</Th>
                    <Th>Location</Th>
                    <Th>Funding Source</Th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <tr key={line.id}>
                      <Td>{line.entry.postedAt ? formatDate(line.entry.postedAt) : '-'}</Td>
                      <Td>
                        <Link href={`/accounting/journal-entries/${line.entry.id}`} className="text-navy-600 hover:underline">
                          {line.entry.number ?? shortId(line.entry.id)}
                        </Link>
                      </Td>
                      <Td>{line.account?.code} - {line.account?.name}</Td>
                      <Td>{line.description ?? line.entry.description ?? '-'}</Td>
                      <Td className="text-right font-mono">{formatAmount(Number(line.debit), line.currencyCode)}</Td>
                      <Td className="text-right font-mono">{formatAmount(Number(line.credit), line.currencyCode)}</Td>
                      <Td className="text-right font-mono font-semibold">{formatAmount(line.runningBalance)}</Td>
                      <Td>{line.project?.code ?? '-'}</Td>
                      <Td>{line.department?.code ?? '-'}</Td>
                      <Td>{line.costCentre?.code ?? '-'}</Td>
                      <Td>{line.location?.code ?? '-'}</Td>
                      <Td>{line.fundingSource?.code ?? '-'}</Td>
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
                    <Button variant="outline" size="sm" disabled={page === 1} onClick={() => handlePageChange(page - 1)}>
                      Previous
                    </Button>
                    <Button variant="outline" size="sm" disabled={page === totalPages} onClick={() => handlePageChange(page + 1)}>
                      Next
                    </Button>
                    <Button variant="outline" size="sm">Export CSV</Button>
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