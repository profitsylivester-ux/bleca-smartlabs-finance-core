'use client';

/* eslint-disable react-hooks/set-state-in-effect */
import { useState, useEffect, useCallback } from 'react';
import { Card, CardHeader, CardBody, Button, Input, Table, Th, Td, Badge, EmptyState, Alert, Label } from '@/components/ui';
import { formatAmount, formatDate } from '@/lib/format';

type TrialBalanceAccount = {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  subCategory: string | null;
  normalBalance: string;
  debit: number;
  credit: number;
  balance: number;
  baseCurrencyDebit: number;
  baseCurrencyCredit: number;
  baseCurrencyBalance: number;
};

type TrialBalanceResponse = {
  data: TrialBalanceAccount[] | Array<{
    accountType: string;
    accounts: TrialBalanceAccount[];
    totalDebit: number;
    totalCredit: number;
    totalBaseDebit: number;
    totalBaseCredit: number;
  }>;
  totals: {
    totalDebit: number;
    totalCredit: number;
    totalBaseDebit: number;
    totalBaseCredit: number;
    balanced: boolean;
  };
};

export default function TrialBalanceClient() {
  const [result, setResult] = useState<TrialBalanceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const today = new Date().toISOString().split('T')[0] ?? new Date().toISOString().slice(0, 10);
  const [filters, setFilters] = useState<{
    asAtDate: string;
    currency: string;
    includeZeroBalances: boolean;
    periodId: string;
    groupBy: 'account' | 'type' | 'subcategory';
  }>({
    asAtDate: today,
    currency: '',
    includeZeroBalances: false,
    periodId: '',
    groupBy: 'account',
  });

  const fetchTrialBalance = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    params.set('asAtDate', filters.asAtDate);
    if (filters.currency) params.set('currency', filters.currency);
    params.set('includeZeroBalances', String(filters.includeZeroBalances));
    if (filters.periodId) params.set('periodId', filters.periodId);
    params.set('groupBy', filters.groupBy);
    try {
      const res = await fetch(`/api/v1/trial-balance?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch trial balance');
      const json = await res.json();
      setResult(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    fetchTrialBalance();
  }, [fetchTrialBalance]);

  const handleFilterChange = (key: string, value: string | boolean) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  if (loading) {
    return (
      <Card>
        <CardBody className="py-12">
          <div className="text-center text-muted-foreground">Loading trial balance…</div>
        </CardBody>
      </Card>
    );
  }

  if (error) {
    return <Alert tone="danger" title="Failed to load trial balance">{error}</Alert>;
  }

  if (!result) {
    return <EmptyState title="No data" />;
  }

  const dataArray = Array.isArray(result.data) ? result.data : [];
  const firstItem = dataArray[0];
  const isGrouped = dataArray.length > 0 && firstItem !== undefined && 'accountType' in firstItem;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Filters" />
        <CardBody>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
            <div>
              <Label htmlFor="asAtDate">As at Date *</Label>
              <Input id="asAtDate" type="date" value={filters.asAtDate} onChange={(e) => handleFilterChange('asAtDate', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="currency">Currency</Label>
              <Input id="currency" placeholder="TZS" maxLength={3} value={filters.currency} onChange={(e) => handleFilterChange('currency', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="periodId">Period ID</Label>
              <Input id="periodId" placeholder="Period ID" value={filters.periodId} onChange={(e) => handleFilterChange('periodId', e.target.value)} />
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 cursor-pointer w-full">
                <input
                  type="checkbox"
                  checked={filters.includeZeroBalances}
                  onChange={(e) => handleFilterChange('includeZeroBalances', e.target.checked)}
                  className="h-4 w-4"
                />
                <span className="text-sm">Include zero balances</span>
              </label>
            </div>
            <div>
              <Label htmlFor="groupBy">Group By</Label>
              <select
                id="groupBy"
                className="border-border-strong text-foreground h-9 w-full rounded-md border bg-white px-3 text-sm"
                value={filters.groupBy}
                onChange={(e) => handleFilterChange('groupBy', e.target.value as 'account' | 'type' | 'subcategory')}
              >
                <option value="account">Account</option>
                <option value="type">Type</option>
                <option value="subcategory">Subcategory</option>
              </select>
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Trial Balance"
          actions={
            <div className="flex items-center gap-2">
              <Badge tone={result.totals.balanced ? 'success' : 'danger'}>
                {result.totals.balanced ? 'Debits = Credits' : 'OUT OF BALANCE'}
              </Badge>
              <Button variant="outline" size="sm">Export CSV</Button>
            </div>
          }
        />
        <CardBody>
          {isGrouped ? (
            <div className="space-y-6">
              {(result.data as Array<{
                accountType: string;
                accounts: TrialBalanceAccount[];
                totalDebit: number;
                totalCredit: number;
                totalBaseDebit: number;
                totalBaseCredit: number;
              }>).map((group) => (
                <div key={group.accountType}>
                  <h3 className="text-sm font-semibold mb-2 text-navy-800">
                    {group.accountType} (Debit: {formatAmount(group.totalDebit)}, Credit: {formatAmount(group.totalCredit)})
                  </h3>
                  <Table>
                    <thead>
                      <tr>
                        <Th>Code</Th>
                        <Th>Account</Th>
                        <Th>Subcategory</Th>
                        <Th>Normal</Th>
                        <Th className="text-right">Debit</Th>
                        <Th className="text-right">Credit</Th>
                        <Th className="text-right">Balance</Th>
                        <Th className="text-right">Base Debit</Th>
                        <Th className="text-right">Base Credit</Th>
                        <Th className="text-right">Base Balance</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.accounts.map((acc) => (
                        <tr key={acc.accountId}>
                          <Td>{acc.accountCode}</Td>
                          <Td>{acc.accountName}</Td>
                          <Td>{acc.subCategory ?? '-'}</Td>
                          <Td>{acc.normalBalance}</Td>
                          <Td className="text-right font-mono">{formatAmount(acc.debit)}</Td>
                          <Td className="text-right font-mono">{formatAmount(acc.credit)}</Td>
                          <Td className="text-right font-mono font-semibold">{formatAmount(acc.balance)}</Td>
                          <Td className="text-right font-mono">{formatAmount(acc.baseCurrencyDebit)}</Td>
                          <Td className="text-right font-mono">{formatAmount(acc.baseCurrencyCredit)}</Td>
                          <Td className="text-right font-mono">{formatAmount(acc.baseCurrencyBalance)}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>Code</Th>
                    <Th>Account</Th>
                    <Th>Type</Th>
                    <Th>Subcategory</Th>
                    <Th>Normal</Th>
                    <Th className="text-right">Debit</Th>
                    <Th className="text-right">Credit</Th>
                    <Th className="text-right">Balance</Th>
                    <Th className="text-right">Base Debit</Th>
                    <Th className="text-right">Base Credit</Th>
                    <Th className="text-right">Base Balance</Th>
                  </tr>
                </thead>
                <tbody>
                  {(result.data as TrialBalanceAccount[]).map((acc) => (
                    <tr key={acc.accountId}>
                      <Td>{acc.accountCode}</Td>
                      <Td>{acc.accountName}</Td>
                      <Td>{acc.accountType}</Td>
                      <Td>{acc.subCategory ?? '-'}</Td>
                      <Td>{acc.normalBalance}</Td>
                      <Td className="text-right font-mono">{formatAmount(acc.debit)}</Td>
                      <Td className="text-right font-mono">{formatAmount(acc.credit)}</Td>
                      <Td className="text-right font-mono font-semibold">{formatAmount(acc.balance)}</Td>
                      <Td className="text-right font-mono">{formatAmount(acc.baseCurrencyDebit)}</Td>
                      <Td className="text-right font-mono">{formatAmount(acc.baseCurrencyCredit)}</Td>
                      <Td className="text-right font-mono">{formatAmount(acc.baseCurrencyBalance)}</Td>
                    </tr>
                  ))}
                  <tr className="font-semibold bg-surface-muted">
                    <Td colSpan={5} className="text-right">Totals</Td>
                    <Td className="text-right font-mono">{formatAmount(result.totals.totalDebit)}</Td>
                    <Td className="text-right font-mono">{formatAmount(result.totals.totalCredit)}</Td>
                    <Td className="text-right font-mono">{formatAmount(result.totals.totalDebit - result.totals.totalCredit)}</Td>
                    <Td className="text-right font-mono">{formatAmount(result.totals.totalBaseDebit)}</Td>
                    <Td className="text-right font-mono">{formatAmount(result.totals.totalBaseCredit)}</Td>
                    <Td className="text-right font-mono">{formatAmount(result.totals.totalBaseDebit - result.totals.totalBaseCredit)}</Td>
                  </tr>
                </tbody>
              </Table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}