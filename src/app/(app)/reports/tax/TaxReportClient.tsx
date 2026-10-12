'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Card, CardBody, CardHeader, Table, Td, Th } from '@/components/ui';

interface TaxReport {
  period: string | null;
  totals: { taxableAmount: string; taxAmount: string };
  rows: Array<{ id: string; period: string; direction: string; status: string; taxableAmount: string; taxAmount: string; currencyCode: string }>;
}

export default function TaxReportClient() {
  const [report, setReport] = useState<TaxReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/v1/reports/tax');
      const result = await response.json() as { data?: TaxReport; error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? 'Could not load tax report.');
      setReport(result.data ?? null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load tax report.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return <Card>{error && <Alert tone="danger" title="Report failed">{error}</Alert>}
    <CardHeader title="Tax report" description="Obligations by period, summed from configured rules." />
    <CardBody>{report && <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <div className="rounded-md bg-surface-subtle px-4 py-3"><p className="text-xs text-muted-foreground">Taxable total</p><p className="font-semibold">{report.totals.taxableAmount}</p></div>
        <div className="rounded-md bg-surface-subtle px-4 py-3"><p className="text-xs text-muted-foreground">Tax total</p><p className="font-semibold">{report.totals.taxAmount}</p></div>
      </div>
      <Table><thead><tr><Th>Period</Th><Th>Direction</Th><Th>Status</Th><Th>Taxable</Th><Th>Tax</Th></tr></thead><tbody>{report.rows.map((row) => <tr key={row.id}><Td className="font-medium">{row.period}</Td><Td>{row.direction}</Td><Td>{row.status}</Td><Td>{row.currencyCode} {row.taxableAmount}</Td><Td className="font-semibold">{row.currencyCode} {row.taxAmount}</Td></tr>)}</tbody></Table>
    </div>}</CardBody></Card>;
}
