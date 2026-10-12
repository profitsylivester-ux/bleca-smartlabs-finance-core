import SalesRegister from '../SalesRegister';
import { requireSalesPageActor } from '@/lib/sales/page-access';
export const metadata = { title: 'Receipts' };
export default async function ReceiptsPage() {
  await requireSalesPageActor('RECEIPTS');
  return <SalesRegister kind="receipts" />;
}
