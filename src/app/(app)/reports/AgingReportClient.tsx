'use client';

import { useEffect, useState } from 'react';
import { Alert, Badge, Card, CardBody, CardHeader, Table, Td, Th } from '@/components/ui';
import { salesRequest } from '../sales/sales-client';

interface AgingRow {
  invoiceId: string;
  number: string;
  partyName: string;
  invoiceDate: string;
  dueDate: string;
  currencyCode: string;
  originalAmount: string;
  paidAmount: string;
  outstandingAmount: string;
  daysPastDue: number;
  bucket: string;
}
interface AgingReport { asOf: string; rows: AgingRow[]; totals: Array<{ currencyCode: string; current: string; days1To30: string; days31To60: string; days61To90: string; days91Plus: string; total: string }>; subledgerMatchesControl: boolean; }

export default function AgingReportClient({ direction }: { direction: 'receivables' | 'payables' }) {
  const [report, setReport] = useState<AgingReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void salesRequest<AgingReport>(`/api/v1/${direction}/aging`).then(setReport).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not load aging report.')); }, [direction]);
  const title = direction === 'receivables' ? 'Accounts receivable aging' : 'Accounts payable aging';
  return <Card>{error && <Alert tone="danger" title="Report failed">{error}</Alert>}<CardHeader title={title} description="Open invoice balances grouped by overdue age, reconciled to the control account ledger." />
    <CardBody>{report && <div className="space-y-4">{!report.subledgerMatchesControl && <Alert tone="warning" title="Subledger and control account differ">Review the posted ledger and open invoice balances.</Alert>}
      <div className="flex flex-wrap gap-3">{report.totals.map((total) => <div key={total.currencyCode} className="rounded-md bg-surface-subtle px-4 py-3"><p className="text-xs text-muted-foreground">{total.currencyCode} outstanding</p><p className="font-semibold">{total.total}</p></div>)}</div>
      <Table><thead><tr><Th>Invoice</Th><Th>Party</Th><Th>Invoice date</Th><Th>Due date</Th><Th>Age</Th><Th>Original</Th><Th>Paid</Th><Th>Outstanding</Th></tr></thead><tbody>{report.rows.map((row) => <tr key={row.invoiceId}><Td className="font-medium">{row.number}</Td><Td>{row.partyName}</Td><Td>{row.invoiceDate.slice(0, 10)}</Td><Td>{row.dueDate.slice(0, 10)}</Td><Td><Badge tone={row.daysPastDue > 0 ? 'warning' : 'success'}>{row.daysPastDue ? `${row.daysPastDue} days` : 'Current'}</Badge></Td><Td>{row.currencyCode} {row.originalAmount}</Td><Td>{row.currencyCode} {row.paidAmount}</Td><Td className="font-semibold">{row.currencyCode} {row.outstandingAmount}</Td></tr>)}</tbody></Table>
    </div>}</CardBody></Card>;
}
