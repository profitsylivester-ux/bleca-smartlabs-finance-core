import SalesCreateClient from '../../SalesCreateClient';
import { requireSalesPageActor } from '@/lib/sales/page-access';
export const metadata = { title: 'New credit note' };
export default async function NewCreditNotePage() {
  await requireSalesPageActor('CREDIT_NOTES');
  return <SalesCreateClient kind="credit-note" />;
}
