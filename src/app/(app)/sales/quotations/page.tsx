import SalesRegister from '../SalesRegister';
import { requireSalesPageActor } from '@/lib/sales/page-access';

export const metadata = { title: 'Quotations' };
export default async function QuotationsPage() {
  await requireSalesPageActor('QUOTATIONS');
  return <SalesRegister kind="quotations" />;
}
