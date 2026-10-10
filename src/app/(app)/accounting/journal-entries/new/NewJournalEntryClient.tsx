'use client';

/* eslint-disable react-hooks/set-state-in-effect */
import { useState, useEffect, useCallback } from 'react';
import { Card, CardHeader, CardBody, Button, Input, Label, Badge, Alert, Table, Th, Td } from '@/components/ui';
import { formatAmount } from '@/lib/format';
import { useRouter } from 'next/navigation';

type JournalLine = {
  id?: string;
  accountId: string;
  lineNumber: number;
  description: string;
  debit: number;
  credit: number;
  currencyCode: string;
  projectId: string | null;
  departmentId: string | null;
  costCentreId: string | null;
  locationId: string | null;
  fundingSourceId: string | null;
  accountCode?: string;
  accountName?: string;
};

type BalanceIndicator = {
  debits: number;
  credits: number;
  balanced: boolean;
  difference: number;
};

type Period = { id: string; code: string; name: string; status: string };
type Account = { id: string; code: string; name: string; type: string; isPostable: boolean; status: string };
type Project = { id: string; code: string; name: string };
type Department = { id: string; code: string; name: string };
type CostCentre = { id: string; code: string; name: string };
type Location = { id: string; code: string; name: string };
type FundingSource = { id: string; code: string; name: string };
type Currency = { code: string; name: string; symbol: string | null };

export default function NewJournalEntryClient() {
  const router = useRouter();
  const [periods, setPeriods] = useState<Period[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [costCentres, setCostCentres] = useState<CostCentre[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [fundingSources, setFundingSources] = useState<FundingSource[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [form, setForm] = useState({
    periodId: '',
    type: 'STANDARD',
    source: 'MANUAL',
    reference: '',
    description: '',
    transactionId: '',
    lines: [] as JournalLine[],
  });

  const [balance, setBalance] = useState<BalanceIndicator>({ debits: 0, credits: 0, balanced: false, difference: 0 });

  const fetchMasterData = useCallback(async () => {
    setLoading(true);
    try {
      const [periodsRes, accountsRes, projectsRes, departmentsRes, costCentresRes, locationsRes, fundingSourcesRes, currenciesRes] = await Promise.all([
        fetch('/api/v1/periods?status=OPEN&status=REOPENED').then(r => r.json()),
        fetch('/api/v1/accounts?status=ACTIVE&isPostable=true').then(r => r.json()),
        fetch('/api/v1/projects?status=ACTIVE').then(r => r.json()),
        fetch('/api/v1/departments?status=ACTIVE').then(r => r.json()),
        fetch('/api/v1/cost-centres?status=ACTIVE').then(r => r.json()),
        fetch('/api/v1/locations?status=ACTIVE').then(r => r.json()),
        fetch('/api/v1/funding-sources?status=ACTIVE').then(r => r.json()),
        fetch('/api/v1/currencies?status=ACTIVE').then(r => r.json()),
      ]);
      setPeriods(periodsRes.data || []);
      setAccounts(accountsRes.data || []);
      setProjects(projectsRes.data || []);
      setDepartments(departmentsRes.data || []);
      setCostCentres(costCentresRes.data || []);
      setLocations(locationsRes.data || []);
      setFundingSources(fundingSourcesRes.data || []);
      setCurrencies(currenciesRes.data || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load master data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMasterData();
  }, [fetchMasterData]);

  const recalculateBalance = useCallback(() => {
    const totalDebit = form.lines.reduce((sum, l) => sum + l.debit, 0);
    const totalCredit = form.lines.reduce((sum, l) => sum + l.credit, 0);
    setBalance({
      debits: totalDebit,
      credits: totalCredit,
      balanced: Math.abs(totalDebit - totalCredit) < 0.000001,
      difference: totalDebit - totalCredit,
    });
  }, [form.lines]);

  useEffect(() => {
    recalculateBalance();
  }, [form.lines, recalculateBalance]);

  const updateLine = (index: number, field: keyof JournalLine, value: string | number | null) => {
    const newLines = [...form.lines];
    newLines[index] = { ...newLines[index], [field]: value } as JournalLine;
    setForm({ ...form, lines: newLines });
  };

  const addLine = () => {
    const newLine: JournalLine = {
      accountId: '',
      lineNumber: form.lines.length + 1,
      description: '',
      debit: 0,
      credit: 0,
      currencyCode: currencies[0]?.code || 'TZS',
      projectId: null,
      departmentId: null,
      costCentreId: null,
      locationId: null,
      fundingSourceId: null,
    };
    setForm({ ...form, lines: [...form.lines, newLine] });
  };

  const removeLine = (index: number) => {
    if (form.lines.length <= 2) {
      alert('A journal entry must have at least 2 lines.');
      return;
    }
    const newLines = form.lines.filter((_, i) => i !== index).map((line, i) => ({ ...line, lineNumber: i + 1 }));
    setForm({ ...form, lines: newLines });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!balance.balanced) {
      alert('Journal entry is not balanced. Debits must equal credits.');
      return;
    }
    if (form.lines.length < 2) {
      alert('A journal entry must have at least 2 lines.');
      return;
    }
    if (!form.periodId) {
      alert('Please select a period.');
      return;
    }
    if (form.lines.some(l => !l.accountId)) {
      alert('All lines must have an account selected.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/v1/journal-entries', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          periodId: form.periodId,
          type: form.type,
          source: form.source,
          reference: form.reference || null,
          description: form.description || null,
          transactionId: form.transactionId || null,
          lines: form.lines.map(l => ({
            accountId: l.accountId,
            lineNumber: l.lineNumber,
            description: l.description || null,
            debit: l.debit,
            credit: l.credit,
            currencyCode: l.currencyCode,
            projectId: l.projectId,
            departmentId: l.departmentId,
            costCentreId: l.costCentreId,
            locationId: l.locationId,
            fundingSourceId: l.fundingSourceId,
          })),
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || 'Failed to create journal entry');
      }
      const json = await res.json();
      router.push(`/accounting/journal-entries/${json.data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create journal entry');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardBody className="py-12">
          <div className="text-center text-muted-foreground">Loading master data…</div>
        </CardBody>
      </Card>
    );
  }

  if (error) {
    return <Alert tone="danger" title="Error">{error}</Alert>;
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Card>
        <CardHeader title="Header Information" />
        <CardBody className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <Label htmlFor="periodId">Period *</Label>
              <select
                id="periodId"
                className="border-border-strong text-foreground h-9 w-full rounded-md border bg-white px-3 text-sm"
                value={form.periodId}
                onChange={(e) => setForm({ ...form, periodId: e.target.value })}
                required
              >
                <option value="">Select period</option>
                {periods.map(p => (
                  <option key={p.id} value={p.id}>{p.code} - {p.name} ({p.status})</option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="type">Type</Label>
              <select
                id="type"
                className="border-border-strong text-foreground h-9 w-full rounded-md border bg-white px-3 text-sm"
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value })}
              >
                <option value="STANDARD">STANDARD</option>
                <option value="OPENING_BALANCE">OPENING_BALANCE</option>
                <option value="ADJUSTMENT">ADJUSTMENT</option>
                <option value="REVERSAL">REVERSAL</option>
                <option value="CORRECTION">CORRECTION</option>
                <option value="CLOSING">CLOSING</option>
                <option value="SYSTEM">SYSTEM</option>
              </select>
            </div>
            <div>
              <Label htmlFor="source">Source</Label>
              <select
                id="source"
                className="border-border-strong text-foreground h-9 w-full rounded-md border bg-white px-3 text-sm"
                value={form.source}
                onChange={(e) => setForm({ ...form, source: e.target.value })}
              >
                <option value="MANUAL">MANUAL</option>
                <option value="TRANSACTION">TRANSACTION</option>
                <option value="INVOICE">INVOICE</option>
                <option value="PAYMENT">PAYMENT</option>
                <option value="RECEIPT">RECEIPT</option>
                <option value="TRANSFER">TRANSFER</option>
                <option value="OPENING_BALANCE">OPENING_BALANCE</option>
                <option value="CLOSE">CLOSE</option>
                <option value="REVERSAL">REVERSAL</option>
                <option value="IMPORT">IMPORT</option>
              </select>
            </div>
            <div>
              <Label htmlFor="reference">Reference</Label>
              <Input
                id="reference"
                value={form.reference}
                onChange={(e) => setForm({ ...form, reference: e.target.value })}
                placeholder="Optional reference"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="description">Description</Label>
            <textarea
              id="description"
              className="border-border-strong text-foreground h-20 w-full rounded-md border bg-white px-3 text-sm"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Optional description"
            />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Lines"
          actions={
            <div className="flex items-center gap-2">
              <Badge tone={balance.balanced ? 'success' : 'danger'} className="mr-2">
                {balance.balanced ? 'Balanced' : `Out of balance by ${formatAmount(Math.abs(balance.difference))}`}
              </Badge>
              <Badge tone="info">Debits: {formatAmount(balance.debits)}</Badge>
              <Badge tone="info">Credits: {formatAmount(balance.credits)}</Badge>
              <Button type="button" size="sm" onClick={addLine}>Add Line</Button>
            </div>
          }
        />
        <CardBody>
          {form.lines.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              No lines added yet. Click Add Line to start.
            </div>
          )}
          <Table>
            <thead>
              <tr>
                <Th style={{ width: '50px' }}>#</Th>
                <Th>Account *</Th>
                <Th>Description</Th>
                <Th style={{ width: '120px' }}>Debit</Th>
                <Th style={{ width: '120px' }}>Credit</Th>
                <Th>Currency</Th>
                <Th>Project</Th>
                <Th>Department</Th>
                <Th>Cost Centre</Th>
                <Th>Location</Th>
                <Th>Funding Source</Th>
                <Th style={{ width: '50px' }}></Th>
              </tr>
            </thead>
            <tbody>
              {form.lines.map((line, index) => (
                <tr key={`${line.id ?? index}-${index}`}>
                  <Td>{index + 1}</Td>
                  <Td>
                    <select
                      className="border-border-strong text-foreground h-9 w-full rounded-md border bg-white px-2 text-sm"
                      value={line.accountId}
                      onChange={(e) => {
                        const selectedAccount = accounts.find(a => a.id === e.target.value);
                        updateLine(index, 'accountId', e.target.value);
                        if (selectedAccount) {
                          updateLine(index, 'accountCode', selectedAccount.code);
                          updateLine(index, 'accountName', selectedAccount.name);
                        }
                      }}
                      required
                    >
                      <option value="">Select account</option>
                      {accounts.map(a => (
                        <option key={a.id} value={a.id}>{a.code} - {a.name} ({a.type})</option>
                      ))}
                    </select>
                  </Td>
                  <Td>
                    <Input
                      value={line.description}
                      onChange={(e) => updateLine(index, 'description', e.target.value)}
                      placeholder="Line description"
                    />
                  </Td>
                  <Td>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={line.debit}
                      onChange={(e) => updateLine(index, 'debit', parseFloat(e.target.value) || 0)}
                      className="w-full"
                    />
                  </Td>
                  <Td>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={line.credit}
                      onChange={(e) => updateLine(index, 'credit', parseFloat(e.target.value) || 0)}
                      className="w-full"
                    />
                  </Td>
                  <Td>
                    <select
                      className="border-border-strong text-foreground h-9 w-full rounded-md border bg-white px-2 text-sm"
                      value={line.currencyCode}
                      onChange={(e) => updateLine(index, 'currencyCode', e.target.value)}
                    >
                      {currencies.map(c => (
                        <option key={c.code} value={c.code}>{c.code}</option>
                      ))}
                    </select>
                  </Td>
                  <Td>
                    <select
                      className="border-border-strong text-foreground h-9 w-full rounded-md border bg-white px-2 text-sm"
                      value={line.projectId || ''}
                      onChange={(e) => updateLine(index, 'projectId', e.target.value || null)}
                    >
                      <option value="">—</option>
                      {projects.map(p => (
                        <option key={p.id} value={p.id}>{p.code}</option>
                      ))}
                    </select>
                  </Td>
                  <Td>
                    <select
                      className="border-border-strong text-foreground h-9 w-full rounded-md border bg-white px-2 text-sm"
                      value={line.departmentId || ''}
                      onChange={(e) => updateLine(index, 'departmentId', e.target.value || null)}
                    >
                      <option value="">—</option>
                      {departments.map(d => (
                        <option key={d.id} value={d.id}>{d.code}</option>
                      ))}
                    </select>
                  </Td>
                  <Td>
                    <select
                      className="border-border-strong text-foreground h-9 w-full rounded-md border bg-white px-2 text-sm"
                      value={line.costCentreId || ''}
                      onChange={(e) => updateLine(index, 'costCentreId', e.target.value || null)}
                    >
                      <option value="">—</option>
                      {costCentres.map(c => (
                        <option key={c.id} value={c.id}>{c.code}</option>
                      ))}
                    </select>
                  </Td>
                  <Td>
                    <select
                      className="border-border-strong text-foreground h-9 w-full rounded-md border bg-white px-2 text-sm"
                      value={line.locationId || ''}
                      onChange={(e) => updateLine(index, 'locationId', e.target.value || null)}
                    >
                      <option value="">—</option>
                      {locations.map(l => (
                        <option key={l.id} value={l.id}>{l.code}</option>
                      ))}
                    </select>
                  </Td>
                  <Td>
                    <select
                      className="border-border-strong text-foreground h-9 w-full rounded-md border bg-white px-2 text-sm"
                      value={line.fundingSourceId || ''}
                      onChange={(e) => updateLine(index, 'fundingSourceId', e.target.value || null)}
                    >
                      <option value="">—</option>
                      {fundingSources.map(f => (
                        <option key={f.id} value={f.id}>{f.code}</option>
                      ))}
                    </select>
                  </Td>
                  <Td>
                    <Button variant="danger" size="sm" onClick={() => removeLine(index)} disabled={form.lines.length <= 2}>
                      ×
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </CardBody>
      </Card>

      <div className="flex justify-end gap-3">
        <Button variant="ghost" onClick={() => router.push('/accounting/journal-entries')}>Cancel</Button>
        <Button type="submit" disabled={submitting || !balance.balanced || form.lines.length < 2}>
          {submitting ? 'Creating…' : 'Create Draft'}
        </Button>
      </div>
    </form>
  );
}