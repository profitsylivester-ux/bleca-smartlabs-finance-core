'use client';

/* eslint-disable react-hooks/set-state-in-effect */
import { useState, useEffect, useCallback } from 'react';
import { Card, CardHeader, CardBody, Button, Input, Table, Th, Td, Badge, EmptyState, Alert, Label } from '@/components/ui';
import { formatAmount, formatDate } from '@/lib/format';

type BalanceSheetCategory = {
  category: string;
  current: number;
  comparative: number;
};

type BalanceSheetResponse = {
  data: {
    assets: BalanceSheetCategory[];
    liabilities: BalanceSheetCategory[];
    equity: BalanceSheetCategory[];
    totals: {
      assets: { current: number; comparative: number };
      liabilities: { current: number; comparative: number };
      equity: { current: number; comparative: number };
    };
    balanced: { current: boolean; comparative: boolean };
    asAtDate: string;
    comparativeDate: string | null;
  };
};

export default function BalanceSheetClient() {
  const [result, setResult] = useState<BalanceSheetResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState({
    asAtDate: new Date().toISOString().split('T')[0],
    currency: '',
    comparativeDate: '',
  });

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    try {
      const res = await fetch(`/api/v1/reports/balance-sheet?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch balance sheet');
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
          <div className="text-center text-muted-foreground">Loading balance sheet…</div>
        </CardBody>
      </Card>
    );
  }

  if (error) {
    return <Alert tone="danger" title="Failed to load balance sheet">{error}</Alert>;
  }

  if (!result) {
    return <EmptyState title="No data" />;
  }

  const { assets, liabilities, equity, totals, balanced, asAtDate, comparativeDate } = result.data;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Filters" />
        <CardBody>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <Label htmlFor="asAtDate">As at Date *</Label>
              <Input id="asAtDate" type="date" value={filters.asAtDate} onChange={(e) => handleFilterChange('asAtDate', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="currency">Currency</Label>
              <Input id="currency" placeholder="TZS" maxLength={3} value={filters.currency} onChange={(e) => handleFilterChange('currency', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="comparativeDate">Comparative Date</Label>
              <Input id="comparativeDate" type="date" value={filters.comparativeDate} onChange={(e) => handleFilterChange('comparativeDate', e.target.value)} />
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Balance Sheet"
          actions={
            <div className="flex items-center gap-2">
              <Badge tone={balanced.current ? 'success' : 'danger'}>
                {balanced.current ? 'Balanced' : 'OUT OF BALANCE'}
              </Badge>
              <Button variant="outline" size="sm">Export CSV</Button>
              <Button variant="outline" size="sm">Export PDF</Button>
            </div>
          }
        />
        <CardBody className="space-y-6">
          <div>
            <h3 className="text-sm font-semibold mb-3 text-navy-800">Assets</h3>
            {assets.length === 0 ? (
              <EmptyState title="No assets" body="No asset entries found for the selected date." />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Category</Th>
                    <Th className="text-right">Current</Th>
                    {comparativeDate && <Th className="text-right">Comparative</Th>}
                    <Th className="text-right">Variance</Th>
                  </tr>
                </thead>
                <tbody>
                  {assets.map((item) => (
                    <tr key={item.category}>
                      <Td>{item.category}</Td>
                      <Td className="text-right font-mono">{formatAmount(item.current)}</Td>
                      {comparativeDate && <Td className="text-right font-mono">{formatAmount(item.comparative)}</Td>}
                      <Td className="text-right font-mono">{formatAmount(item.current - item.comparative)}</Td>
                    </tr>
                  ))}
                  <tr className="font-semibold bg-surface-muted">
                    <Td>Total Assets</Td>
                    <Td className="text-right font-mono">{formatAmount(totals.assets.current)}</Td>
                    {comparativeDate && <Td className="text-right font-mono">{formatAmount(totals.assets.comparative)}</Td>}
                    <Td className="text-right font-mono">{formatAmount(totals.assets.current - totals.assets.comparative)}</Td>
                  </tr>
                </tbody>
              </Table>
            )}
          </div>

          <div className="border-t pt-6">
            <h3 className="text-sm font-semibold mb-3 text-navy-800">Liabilities</h3>
            {liabilities.length === 0 ? (
              <EmptyState title="No liabilities" body="No liability entries found for the selected date." />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Category</Th>
                    <Th className="text-right">Current</Th>
                    {comparativeDate && <Th className="text-right">Comparative</Th>}
                    <Th className="text-right">Variance</Th>
                  </tr>
                </thead>
                <tbody>
                  {liabilities.map((item) => (
                    <tr key={item.category}>
                      <Td>{item.category}</Td>
                      <Td className="text-right font-mono">{formatAmount(item.current)}</Td>
                      {comparativeDate && <Td className="text-right font-mono">{formatAmount(item.comparative)}</Td>}
                      <Td className="text-right font-mono">{formatAmount(item.current - item.comparative)}</Td>
                    </tr>
                  ))}
                  <tr className="font-semibold bg-surface-muted">
                    <Td>Total Liabilities</Td>
                    <Td className="text-right font-mono">{formatAmount(totals.liabilities.current)}</Td>
                    {comparativeDate && <Td className="text-right font-mono">{formatAmount(totals.liabilities.comparative)}</Td>}
                    <Td className="text-right font-mono">{formatAmount(totals.liabilities.current - totals.liabilities.comparative)}</Td>
                  </tr>
                </tbody>
              </Table>
            )}
          </div>

          <div className="border-t pt-6">
            <h3 className="text-sm font-semibold mb-3 text-navy-800">Equity</h3>
            {equity.length === 0 ? (
              <EmptyState title="No equity" body="No equity entries found for the selected date." />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Category</Th>
                    <Th className="text-right">Current</Th>
                    {comparativeDate && <Th className="text-right">Comparative</Th>}
                    <Th className="text-right">Variance</Th>
                  </tr>
                </thead>
                <tbody>
                  {equity.map((item) => (
                    <tr key={item.category}>
                      <Td>{item.category}</Td>
                      <Td className="text-right font-mono">{formatAmount(item.current)}</Td>
                      {comparativeDate && <Td className="text-right font-mono">{formatAmount(item.comparative)}</Td>}
                      <Td className="text-right font-mono">{formatAmount(item.current - item.comparative)}</Td>
                    </tr>
                  ))}
                  <tr className="font-semibold bg-surface-muted">
                    <Td>Total Equity</Td>
                    <Td className="text-right font-mono">{formatAmount(totals.equity.current)}</Td>
                    {comparativeDate && <Td className="text-right font-mono">{formatAmount(totals.equity.comparative)}</Td>}
                    <Td className="text-right font-mono">{formatAmount(totals.equity.current - totals.equity.comparative)}</Td>
                  </tr>
                </tbody>
              </Table>
            )}
          </div>

          <div className="border-t pt-6 bg-navy-50 rounded-lg p-4">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <div className="text-sm text-muted-foreground">Total Assets</div>
                <div className="text-lg font-semibold">{formatAmount(totals.assets.current)}</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground">Total Liabilities</div>
                <div className="text-lg font-semibold">{formatAmount(totals.liabilities.current)}</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground">Total Equity</div>
                <div className="text-lg font-semibold">{formatAmount(totals.equity.current)}</div>
              </div>
            </div>
            <div className="mt-4 flex justify-between items-center border-t pt-4">
              <span className="text-lg font-semibold">Liabilities + Equity</span>
              <span className={`text-lg font-semibold ${balanced.current ? 'text-positive' : 'text-negative'}`}>
                {formatAmount(totals.liabilities.current + totals.equity.current)}
                {balanced.current ? ' ✓' : ' ✗'}
              </span>
            </div>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}