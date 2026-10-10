'use client';

/* eslint-disable react-hooks/set-state-in-effect */
import { useState, useEffect, useCallback } from 'react';
import { Card, CardHeader, CardBody, Button, Input, Table, Th, Td, Badge, EmptyState, Alert, Label } from '@/components/ui';
import { formatAmount, formatDate } from '@/lib/format';

type CashFlowResponse = {
  data: {
    operatingActivities: { netCashFromOperating: number };
    investingActivities: { netCashFromInvesting: number };
    financingActivities: { netCashFromFinancing: number };
    netChangeInCash: number;
    cashAtBeginning: number;
    cashAtEnd: number;
    period: { periodId: string | null; startDate: Date | null; endDate: Date | null };
  };
};

export default function CashFlowClient() {
  const [result, setResult] = useState<CashFlowResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState({
    periodId: '',
    startDate: '',
    endDate: '',
    currency: '',
  });

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    try {
      const res = await fetch(`/api/v1/reports/cash-flow?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch cash flow statement');
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
          <div className="text-center text-muted-foreground">Loading cash flow statement…</div>
        </CardBody>
      </Card>
    );
  }

  if (error) {
    return <Alert tone="danger" title="Failed to load cash flow statement">{error}</Alert>;
  }

  if (!result) {
    return <EmptyState title="No data" />;
  }

  const { operatingActivities, investingActivities, financingActivities, netChangeInCash, cashAtBeginning, cashAtEnd } = result.data;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Filters" />
        <CardBody>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
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
              <Label htmlFor="currency">Currency</Label>
              <Input id="currency" placeholder="TZS" maxLength={3} value={filters.currency} onChange={(e) => handleFilterChange('currency', e.target.value)} />
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Cash Flow Statement (Indirect Method)"
          actions={
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm">Export CSV</Button>
              <Button variant="outline" size="sm">Export PDF</Button>
            </div>
          }
        />
        <CardBody className="space-y-6">
          <div>
            <h3 className="text-sm font-semibold mb-3 text-navy-800">Operating Activities</h3>
            <Table>
              <thead>
                <tr>
                  <Th>Description</Th>
                  <Th className="text-right">Amount</Th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <Td>Net cash from operating activities</Td>
                  <Td className="text-right font-mono font-semibold">{formatAmount(operatingActivities.netCashFromOperating)}</Td>
                </tr>
              </tbody>
            </Table>
          </div>

          <div className="border-t pt-6">
            <h3 className="text-sm font-semibold mb-3 text-navy-800">Investing Activities</h3>
            <Table>
              <thead>
                <tr>
                  <Th>Description</Th>
                  <Th className="text-right">Amount</Th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <Td>Net cash from investing activities</Td>
                  <Td className="text-right font-mono font-semibold">{formatAmount(investingActivities.netCashFromInvesting)}</Td>
                </tr>
              </tbody>
            </Table>
          </div>

          <div className="border-t pt-6">
            <h3 className="text-sm font-semibold mb-3 text-navy-800">Financing Activities</h3>
            <Table>
              <thead>
                <tr>
                  <Th>Description</Th>
                  <Th className="text-right">Amount</Th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <Td>Net cash from financing activities</Td>
                  <Td className="text-right font-mono font-semibold">{formatAmount(financingActivities.netCashFromFinancing)}</Td>
                </tr>
              </tbody>
            </Table>
          </div>

          <div className="border-t pt-6 bg-navy-50 rounded-lg p-4 space-y-2">
            <div className="flex justify-between">
              <span>Net change in cash</span>
              <span className="font-semibold">{formatAmount(netChangeInCash)}</span>
            </div>
            <div className="flex justify-between">
              <span>Cash at beginning of period</span>
              <span className="font-semibold">{formatAmount(cashAtBeginning)}</span>
            </div>
            <div className="flex justify-between border-t pt-2">
              <span className="font-semibold">Cash at end of period</span>
              <span className="font-semibold text-lg">{formatAmount(cashAtEnd)}</span>
            </div>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}