'use client';

import { useState, useCallback } from 'react';
import { Card, CardHeader, CardBody, Badge, Button, Alert, EmptyState } from '@/components/ui';
import { formatDate, formatAmount } from '@/lib/format';

type Period = {
  id: string;
  code: string;
  name: string;
  status: string;
  type: string;
  startDate: Date | string;
  endDate: Date | string;
};

type Actor = {
  roleCodes: string[];
};

interface YearEndResult {
  closingEntryId: string;
  retainedEarningsAccountId: string;
  netIncome: string;
  incomeAccountsCleared: number;
  expenseAccountsCleared: number;
}

export default function YearEndClient({
  actor,
  period,
  canRunYearEnd,
}: {
  actor: Actor;
  period: Period;
  canRunYearEnd: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<YearEndResult | null>(null);

  const handleRunYearEnd = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/v1/periods/${period.id}/year-end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? 'Year-end procedure failed');
      }

      const body = await res.json();
      setResult(body.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Year-end procedure failed');
    } finally {
      setLoading(false);
    }
  }, [period.id]);

  const canExecute = canRunYearEnd && ['CLOSED', 'LOCKED'].includes(period.status);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title={`Year-End Procedure: ${period.code} — ${period.name}`}
          description={`Fiscal year: ${formatDate(period.startDate)} to ${formatDate(period.endDate)}`}
          actions={
            canExecute && (
              <Button onClick={handleRunYearEnd} disabled={loading} variant="default">
                {loading ? 'Running…' : 'Run Year-End Procedure'}
              </Button>
            )
          }
        />
        <CardBody>
          <div className="mb-4 flex flex-wrap gap-2">
            <Badge tone={period.status === 'LOCKED' ? 'success' : period.status === 'CLOSED' ? 'info' : 'neutral'}>
              {period.status}
            </Badge>
            {!canRunYearEnd && <Badge tone="neutral">Insufficient permissions (requires CEO or Finance Officer)</Badge>}
            {canRunYearEnd && !canExecute && <Badge tone="warning">Period must be CLOSED or LOCKED</Badge>}
          </div>

          <div className="prose max-w-none mb-6">
            <h4 className="font-semibold mb-2">What this does:</h4>
            <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
              <li>Computes net income for the fiscal year from all posted journal entries</li>
              <li>Creates a closing journal entry that zeros out all revenue and expense accounts</li>
              <li>Moves net income (or loss) to the retained earnings account</li>
              <li>Requires CEO sign-off via the approval engine</li>
              <li>Produces a balanced entry (debits = credits) that is audited</li>
            </ul>
            <p className="mt-2 text-sm text-muted-foreground">
              <strong>Prerequisites:</strong> Period must be ANNUAL type and in CLOSED or LOCKED status.
              All income/expense accounts with non-zero balances will be cleared.
            </p>
          </div>

          {error && <Alert tone="danger">{error}</Alert>}

          {result && (
            <div className="space-y-4">
              <h4 className="font-semibold">Year-End Completed Successfully</h4>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="p-4 bg-green-50 rounded-lg border border-green-200">
                  <p className="text-sm text-green-800 font-medium">Net Income</p>
                  <p className="font-mono text-lg text-green-900">{formatAmount(Number(result.netIncome), 'TZS')}</p>
                </div>
                <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                  <p className="text-sm text-blue-800 font-medium">Income Accounts Cleared</p>
                  <p className="font-mono text-lg text-blue-900">{result.incomeAccountsCleared}</p>
                </div>
                <div className="p-4 bg-purple-50 rounded-lg border border-purple-200">
                  <p className="text-sm text-purple-800 font-medium">Expense Accounts Cleared</p>
                  <p className="font-mono text-lg text-purple-900">{result.expenseAccountsCleared}</p>
                </div>
              </div>
              <div className="p-4 bg-gray-50 rounded-lg border">
                <p className="text-sm text-gray-700 font-medium">Closing Journal Entry</p>
                <p className="font-mono text-sm text-gray-900">{result.closingEntryId}</p>
                <p className="text-xs text-gray-500 mt-1">Retained Earnings Account: {result.retainedEarningsAccountId}</p>
              </div>
            </div>
          )}

          {!result && !canExecute && (
            <EmptyState
              title="Year-end not available"
              body="Ensure the period is ANNUAL type and has been closed or locked. CEO or Finance Officer role required."
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}