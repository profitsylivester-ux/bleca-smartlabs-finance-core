import SalesRegister from '../SalesRegister';
import { requireSalesPageActor } from '@/lib/sales/page-access';
export const metadata = { title: 'Payments' };
export default async function PaymentsPage() {
  await requireSalesPageActor('PAYMENTS');
  return <SalesRegister kind="payments" />;
}
