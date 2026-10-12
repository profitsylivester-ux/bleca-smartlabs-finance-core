'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, Badge, Card, CardBody, CardHeader, EmptyState, Select, SelectOption, Table, Td, Th } from '@/components/ui';
import { formatAmount, formatDate } from '@/lib/format';
import { budgetApi, type ApiEnvelope } from './budget-client-utils';

type BudgetRow = {
  id: string;
  code: string;
  name: string;
  status: string;
  type: string;
  periodType: string;
  startDate: string;
  endDate: string;
  currencyCode: string;
  approved: string;
  committed: string;
  actual: string;
  available: string;
  isOverBudget: boolean;
  lineCount: number;
};

export default function BudgetsClient({ actor }: { actor: { roleCodes: string[] } }) {
  const [budgets, setBudgets] = useState<BudgetRow[]>([]);
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const query = new URLSearchParams();
    if (status) query.set('status', status);
    if (type) query.set('type', type);
    try {
      const result = await budgetApi<BudgetRow[]>(`/api/v1/budgets?${query.toString()}`);
      setBudgets(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load budgets.');
    } finally {
      setLoading(false);
    }
  }, [status, type]);

  useEffect(() => { void load(); }, [load]);

  const canCreate = actor.roleCodes.includes('BUDGETS.CREATE');
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Budgets & commitments"
          description="Track approved amounts, open commitments, posted actuals, and available balances."
          actions={canCreate ? <span className="text-xs text-muted-foreground">Create budgets through the finance workflow.</span> : null}
        />
        <CardBody>
          <div className="mb-4 grid gap-3 sm:grid-cols-2">
            <Select aria-label="Filter by status" value={status} onChange={(event) => setStatus(event.target.value)}>
              <SelectOption value="">All statuses</SelectOption>
              {['DRAFT', 'SUBMITTED', 'APPROVED', 'ACTIVE', 'REVISED', 'CLOSED', 'EXPIRED', 'REJECTED'].map((value) => (
                <SelectOption key={value} value={value}>{value.replaceAll('_', ' ')}</SelectOption>
              ))}
            </Select>
            <Select aria-label="Filter by budget level" value={type} onChange={(event) => setType(event.target.value)}>
              <SelectOption value="">All levels</SelectOption>
              {['COMPANY', 'DEPARTMENT', 'PROJECT', 'FUNDING', 'ACTIVITY'].map((value) => (
                <SelectOption key={value} value={value}>{value.replaceAll('_', ' ')}</SelectOption>
              ))}
            </Select>
          </div>
          {error && <Alert tone="danger" title="Could not load budgets">{error}</Alert>}
          {loading ? <p className="text-sm text-muted-foreground">Loading budgets…</p> : budgets.length === 0 ? (
            <EmptyState title="No budgets found" body="Adjust the filters or create a budget to begin tracking available funds." />
          ) : (
            <Table>
              <thead><tr><Th>Budget</Th><Th>Level</Th><Th>Period</Th><Th>Status</Th><Th>Approved</Th><Th>Committed</Th><Th>Actual</Th><Th>Available</Th></tr></thead>
              <tbody>
                {budgets.map((budget) => (
                  <tr key={budget.id}>
                    <Td><Link className="font-medium text-navy-700 hover:underline" href={`/budgets/${budget.id}`}>{budget.code}</Link><div className="text-xs text-muted-foreground">{budget.name} · {budget.lineCount} lines</div></Td>
                    <Td>{budget.type}</Td>
                    <Td>{formatDate(budget.startDate)} – {formatDate(budget.endDate)}</Td>
                    <Td><Badge tone={budget.status === 'ACTIVE' ? 'success' : budget.status === 'SUBMITTED' ? 'warning' : 'neutral'}>{budget.status}</Badge></Td>
                    <Td>{formatAmount(Number(budget.approved), budget.currencyCode)}</Td>
                    <Td>{formatAmount(Number(budget.committed), budget.currencyCode)}</Td>
                    <Td>{formatAmount(Number(budget.actual), budget.currencyCode)}</Td>
                    <Td><span className={budget.isOverBudget ? 'font-semibold text-danger-700' : ''}>{formatAmount(Number(budget.available), budget.currencyCode)}</span></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
