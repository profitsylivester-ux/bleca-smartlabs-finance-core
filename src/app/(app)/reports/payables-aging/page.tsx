import AgingReportClient from '../AgingReportClient';
import { requireSalesPageActor } from '@/lib/sales/page-access';
export const metadata = { title: 'Payables Aging' };
export default async function PayablesAgingPage() {
  await requireSalesPageActor('REPORTS');
  return <AgingReportClient direction="payables" />;
}
