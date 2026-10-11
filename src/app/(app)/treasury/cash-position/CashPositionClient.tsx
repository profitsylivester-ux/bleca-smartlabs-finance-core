'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Card, CardHeader, CardBody, Table, Th, Td, Badge, Input, EmptyState, Alert, Select, SelectOption, Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui';
import { formatAmount, formatDate } from '@/lib/format';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

type CashPosition = {
  treasuryAccountId: string;
  code: string;
  name: string;
  kind: string;
  currencyCode: string;
  isRestricted: boolean;
  fundingSource: { id: string; code: string; name: string; type: string } | null;
  balance: number;
  balanceInBaseCurrency: number;
  totalDebits: number;
  totalCredits: number;
  asOf: string;
};

type CashPositionSummary = {
  positions: CashPosition[];
  byCurrency: { currencyCode: string; totalBalance: number; accountCount: number }[];
  byKind: { kind: string; totalBalance: number; accountCount: number }[];
  grandTotal: number;
  asOf: string;
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

function getBalanceTone(balance: number): 'neutral' | 'success' | 'danger' {
  if (balance > 0) return 'success';
  if (balance < 0) return 'danger';
  return 'neutral';
}

export default function CashPositionClient({ actor }: { actor: Actor }) {
  const searchParams = useSearchParams();
  const [summary, setSummary] = useState<CashPositionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'all' | 'byCurrency' | 'byKind'>('all');

  const handleTabChange = (value: string) => {
    setActiveTab(value as 'all' | 'byCurrency' | 'byKind');
  };

  const initialFilters = useMemo(() => ({
    currencyCode: searchParams.get('currencyCode') || '',
    kind: searchParams.get('kind') || '',
    asOf: searchParams.get('asOf') || new Date().toISOString(),
  }), [searchParams]);

  const [filters, setFilters] = useState(initialFilters);

  const fetchCashPosition = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });

    try {
      const res = await fetch(`/api/v1/cash-position?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch cash position');
      const json = await res.json();
      setSummary(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  const fetchRef = useRef(fetchCashPosition);
  useEffect(() => {
    fetchRef.current = fetchCashPosition;
  }, [fetchCashPosition]);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchRef.current();
    }, 0);
    return () => clearTimeout(timer);
  }, [fetchCashPosition]);

  const handleFilterChange = (key: string, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const handleAsOfChange = (value: string) => {
    setFilters((prev) => ({ ...prev, asOf: value }));
  };

  if (loading) {
    return (
      <Card>
        <CardBody className="py-12">
          <div className="text-center text-muted-foreground">Loading cash position…</div>
        </CardBody>
      </Card>
    );
  }

  if (error) {
    return <Alert tone="danger" title="Failed to load cash position">{error}</Alert>;
  }

  if (!summary) {
    return <EmptyState title="No data" body="No cash position data available." />;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Cash Position"
          description={`As of ${formatDate(filters.asOf)}`}
          actions={
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-muted-foreground">As of:</label>
              <Input
                type="datetime-local"
                value={filters.asOf.slice(0, 16)}
                onChange={(e) => handleAsOfChange(e.target.value)}
                className="w-auto"
              />
            </div>
          }
        />
        <CardBody>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Currency</label>
              <Select value={filters.currencyCode} onChange={(e) => handleFilterChange('currencyCode', e.target.value)}>
                <SelectOption value="">All</SelectOption>
                {summary.byCurrency.map((c) => (
                  <SelectOption key={c.currencyCode} value={c.currencyCode}>{c.currencyCode}</SelectOption>
                ))}
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Account Kind</label>
              <Select value={filters.kind} onChange={(e) => handleFilterChange('kind', e.target.value)}>
                <SelectOption value="">All</SelectOption>
                {summary.byKind.map((k) => (
                  <SelectOption key={k.kind} value={k.kind}>{k.kind}</SelectOption>
                ))}
              </Select>
            </div>
          </div>
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader title="Total Balance" className="pb-2" />
          <CardBody className="pt-0">
            <div className="text-3xl font-bold tabular-nums text-success">
              {formatAmount(summary.grandTotal, 'TZS')}
            </div>
            <div className="text-sm text-muted-foreground mt-1">
              Across {summary.positions.length} treasury accounts
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Active Currencies" className="pb-2" />
          <CardBody className="pt-0">
            <div className="text-3xl font-bold tabular-nums text-navy-600">
              {summary.byCurrency.length}
            </div>
            <div className="text-sm text-muted-foreground mt-1">
              Currency groups
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Account Types" className="pb-2" />
          <CardBody className="pt-0">
            <div className="text-3xl font-bold tabular-nums text-navy-600">
              {summary.byKind.length}
            </div>
            <div className="text-sm text-muted-foreground mt-1">
              Account kind groups
            </div>
          </CardBody>
        </Card>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList className="w-full">
          <TabsTrigger value="all">All Accounts</TabsTrigger>
          <TabsTrigger value="byCurrency">By Currency</TabsTrigger>
          <TabsTrigger value="byKind">By Account Kind</TabsTrigger>
        </TabsList>

        <TabsContent value="all">
          <Card>
            <CardHeader title="Treasury Account Balances" />
            <CardBody>
              {summary.positions.length === 0 ? (
                <EmptyState title="No accounts" body="No treasury accounts match the current filters." />
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Code</Th>
                      <Th>Name</Th>
                      <Th>Kind</Th>
                      <Th>Currency</Th>
                      <Th>Restricted</Th>
                      <Th>Funding Source</Th>
                      <Th className="text-right">Balance</Th>
                      <Th className="text-right">Total Debits</Th>
                      <Th className="text-right">Total Credits</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.positions.map((pos) => (
                      <tr key={pos.treasuryAccountId}>
                        <Td>
                          <Link href={`/treasury/accounts/${pos.treasuryAccountId}`} className="text-navy-600 hover:underline font-mono">
                            {pos.code}
                          </Link>
                        </Td>
                        <Td className="max-w-xs truncate">{pos.name}</Td>
                        <Td>
                          <Badge tone={getKindTone(pos.kind)}>{pos.kind.replace('_', ' ')}</Badge>
                        </Td>
                        <Td>{pos.currencyCode}</Td>
                        <Td>
                          <Badge tone={pos.isRestricted ? 'warning' : 'neutral'}>{pos.isRestricted ? 'Yes' : 'No'}</Badge>
                        </Td>
                        <Td>
                          {pos.fundingSource ? (
                            <Link href={`/treasury/accounts/${pos.treasuryAccountId}`} className="text-navy-600 hover:underline text-sm">
                              {pos.fundingSource.code} - {pos.fundingSource.name}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </Td>
                        <Td className="text-right font-mono tabular-nums">
                          <span className={getBalanceTone(pos.balance) === 'success' ? 'text-success' : getBalanceTone(pos.balance) === 'danger' ? 'text-danger' : ''}>
                            {formatAmount(pos.balance, pos.currencyCode)}
                          </span>
                        </Td>
                        <Td className="text-right font-mono tabular-nums text-muted-foreground">
                          {formatAmount(pos.totalDebits, pos.currencyCode)}
                        </Td>
                        <Td className="text-right font-mono tabular-nums text-muted-foreground">
                          {formatAmount(pos.totalCredits, pos.currencyCode)}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </CardBody>
          </Card>
        </TabsContent>

        <TabsContent value="byCurrency">
          <Card>
            <CardHeader title="Balances by Currency" />
            <CardBody>
              {summary.byCurrency.length === 0 ? (
                <EmptyState title="No currency data" body="No currency balances available." />
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Currency</Th>
                      <Th>Total Balance (Base)</Th>
                      <Th>Account Count</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.byCurrency.map((currency) => (
                      <tr key={currency.currencyCode}>
                        <Td className="font-mono">{currency.currencyCode}</Td>
                        <Td className="text-right font-mono tabular-nums">
                          {formatAmount(currency.totalBalance, 'TZS')}
                        </Td>
                        <Td className="text-right">{currency.accountCount}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </CardBody>
          </Card>
        </TabsContent>

        <TabsContent value="byKind">
          <Card>
            <CardHeader title="Balances by Account Kind" />
            <CardBody>
              {summary.byKind.length === 0 ? (
                <EmptyState title="No kind data" body="No account kind balances available." />
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Kind</Th>
                      <Th>Total Balance (Base)</Th>
                      <Th>Account Count</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.byKind.map((kind) => (
                      <tr key={kind.kind}>
                        <Td>
                          <Badge tone={getKindTone(kind.kind)}>{kind.kind.replace('_', ' ')}</Badge>
                        </Td>
                        <Td className="text-right font-mono tabular-nums">
                          {formatAmount(kind.totalBalance, 'TZS')}
                        </Td>
                        <Td className="text-right">{kind.accountCount}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </CardBody>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}