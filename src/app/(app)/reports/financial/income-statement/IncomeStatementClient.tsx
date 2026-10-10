'use client';

/* eslint-disable react-hooks/set-state-in-effect */
import { useState, useEffect, useCallback } from 'react';
import { Card, CardHeader, CardBody, Button, Input, Table, Th, Td, Badge, EmptyState, Alert, Label } from '@/components/ui';
import { formatAmount, formatDate } from '@/lib/format';

type IncomeStatementCategory = {
  category: string;
  current: number;
  comparative: number;
};

type IncomeStatementResponse = {
  data: {
    revenue: IncomeStatementCategory[];
    expense: IncomeStatementCategory[];
    totals: {
      revenue: { current: number; comparative: number };
      expense: { current: number; comparative: number };
      netSurplusDeficit: { current: number; comparative: number };
    };
    period: { periodId: string | null; startDate: Date | null; endDate: Date | null };
    comparativePeriod: string | null;
  };
};

export default function IncomeStatementClient() {
  const [result, setResult] = useState<IncomeStatementResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState({
    periodId: '',
    startDate: '',
    endDate: '',
    projectId: '',
    departmentId: '',
    costCentreId: '',
    fundingSourceId: '',
    currency: '',
    comparativePeriodId: '',
  });

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    try {
      const res = await fetch(`/api/v1/reports/income-statement?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch income statement');
      const json = await res.json();
      setResult(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  const handleFilterChange = (key: string, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  if (loading) {
    return (
      <Card>
        <CardBody className="py-12">
          <div className="text-center text-muted-foreground">Loading income statement…</div>
        </CardBody>
      </Card>
    );
  }

  if (error) {
    return <Alert tone="danger" title="Failed to load income statement">{error}</Alert>;
  }

  if (!result) {
    return <EmptyState title="No data" />;
  }

  const { revenue, expense, totals } = result.data;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Filters" />
        <CardBody>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
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
              <Label htmlFor="comparativePeriodId">Comparative Period</Label>
              <Input id="comparativePeriodId" placeholder="Period ID" value={filters.comparativePeriodId} onChange={(e) => handleFilterChange('comparativePeriodId', e.target.value)} />
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
        <CardHeader
          title="Income Statement"
          actions={
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm">Export CSV</Button>
              <Button variant="outline" size="sm">Export PDF</Button>
            </div>
          }
        />
        <CardBody className="space-y-6">
          <div>
            <h3 className="text-sm font-semibold mb-3 text-navy-800">Revenue</h3>
            {revenue.length === 0 ? (
              <EmptyState title="No revenue" body="No revenue entries found for the selected period." />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Category</Th>
                    <Th className="text-right">Current Period</Th>
                    {result.data.comparativePeriod && (
                      <Th className="text-right">Comparative Period</Th>
                    )}
                    <Th className="text-right">Variance</Th>
                  </tr>
                </thead>
                <tbody>
                  {revenue.map((item) => (
                    <tr key={item.category}>
                      <Td>{item.category}</Td>
                      <Td className="text-right font-mono">{formatAmount(item.current)}</Td>
                      {result.data.comparativePeriod && (
                        <Td className="text-right font-mono">{formatAmount(item.comparative)}</Td>
                      )}
                      <Td className="text-right font-mono">
                        {formatAmount(item.current - item.comparative)}
                      </Td>
                    </tr>
                  ))}
                  <tr className="font-semibold bg-surface-muted">
                    <Td>Total Revenue</Td>
                    <Td className="text-right font-mono">{formatAmount(totals.revenue.current)}</Td>
                    {result.data.comparativePeriod && (
                      <Td className="text-right font-mono">{formatAmount(totals.revenue.comparative)}</Td>
                    )}
                    <Td className="text-right font-mono">{formatAmount(totals.revenue.current - totals.revenue.comparative)}</Td>
                  </tr>
                </tbody>
              </Table>
            )}
          </div>

          <div className="border-t pt-6">
            <h3 className="text-sm font-semibold mb-3 text-navy-800">Expenses</h3>
            {expense.length === 0 ? (
              <EmptyState title="No expenses" body="No expense entries found for the selected period." />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Category</Th>
                    <Th className="text-right">Current Period</Th>
                    {result.data.comparativePeriod && (
                      <Th className="text-right">Comparative Period</Th>
                    )}
                    <Th className="text-right">Variance</Th>
                  </tr>
                </thead>
                <tbody>
                  {expense.map((item) => (
                    <tr key={item.category}>
                      <Td>{item.category}</Td>
                      <Td className="text-right font-mono">{formatAmount(item.current)}</Td>
                      {result.data.comparativePeriod && (
                        <Td className="text-right font-mono">{formatAmount(item.comparative)}</Td>
                      )}
                      <Td className="text-right font-mono">
                        {formatAmount(item.current - item.comparative)}
                      </Td>
                    </tr>
                  ))}
                  <tr className="font-semibold bg-surface-muted">
                    <Td>Total Expenses</Td>
                    <Td className="text-right font-mono">{formatAmount(totals.expense.current)}</Td>
                    {result.data.comparativePeriod && (
                      <Td className="text-right font-mono">{formatAmount(totals.expense.comparative)}</Td>
                    )}
                    <Td className="text-right font-mono">{formatAmount(totals.expense.current - totals.expense.comparative)}</Td>
                  </tr>
                </tbody>
              </Table>
            )}
          </div>

          <div className="border-t pt-6 bg-navy-50 rounded-lg p-4">
            <div className="flex justify-between items-center">
              <span className="text-lg font-semibold">Net Surplus / (Deficit)</span>
              <span className={`text-lg font-semibold ${totals.netSurplusDeficit.current >= 0 ? 'text-positive' : 'text-negative'}`}>
                {formatAmount(totals.netSurplusDeficit.current)}
              </span>
            </div>
            {result.data.comparativePeriod && (
              <div className="flex justify-between items-center mt-2 text-sm text-muted-foreground">
                <span>Comparative: {formatAmount(totals.netSurplusDeficit.comparative)}</span>
                <span>Variance: {formatAmount(totals.netSurplusDeficit.current - totals.netSurplusDeficit.comparative)}</span>
              </div>
            )}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}