import SalesCreateClient from '../../SalesCreateClient';
import { requireSalesPageActor } from '@/lib/sales/page-access';
export const metadata = { title: 'New payment' };
export default async function NewPaymentPage() {
  await requireSalesPageActor('PAYMENTS');
  return <SalesCreateClient kind="payment" />;
}
