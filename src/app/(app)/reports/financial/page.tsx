import Link from 'next/link';
import { Card, CardBody, CardHeader } from '@/components/ui';
import { requireSalesPageActor } from '@/lib/sales/page-access';

export const metadata = { title: 'Financial Reports' };
const reports = [
  { href: '/reports/financial/income-statement', title: 'Income statement', description: 'Revenue, expenses and net surplus or deficit.' },
  { href: '/reports/financial/balance-sheet', title: 'Balance sheet', description: 'Assets, liabilities and equity at a point in time.' },
  { href: '/reports/financial/cash-flow', title: 'Cash flow', description: 'Cash movements across operating, investing and financing activity.' },
  { href: '/reports/receivables-aging', title: 'Receivables aging', description: 'Customer invoice balances and overdue buckets.' },
  { href: '/reports/payables-aging', title: 'Payables aging', description: 'Supplier invoice balances and overdue buckets.' },
];

export default async function FinancialReportsPage() {
  await requireSalesPageActor('REPORTS');
  return <div className="space-y-5"><Card><CardHeader title="Financial reports" description="Ledger and subledger reports for financial oversight." /><CardBody><div className="grid gap-3 md:grid-cols-2">{reports.map((report) => <Link key={report.href} href={report.href} className="rounded-lg border border-border p-4 hover:bg-surface-subtle"><h2 className="font-medium text-navy-800">{report.title}</h2><p className="mt-1 text-sm text-muted-foreground">{report.description}</p></Link>)}</div></CardBody></Card></div>;
}
