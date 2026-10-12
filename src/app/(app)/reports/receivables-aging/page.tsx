import AgingReportClient from '../AgingReportClient';
import { requireSalesPageActor } from '@/lib/sales/page-access';
export const metadata = { title: 'Receivables Aging' };
export default async function ReceivablesAgingPage() {
  await requireSalesPageActor('REPORTS');
  return <AgingReportClient direction="receivables" />;
}
