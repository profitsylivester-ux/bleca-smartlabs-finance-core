import SalesRegister from '../SalesRegister';
import { requireSalesPageActor } from '@/lib/sales/page-access';
export const metadata = { title: 'Credit notes' };
export default async function CreditNotesPage() {
  await requireSalesPageActor('CREDIT_NOTES');
  return <SalesRegister kind="credit-notes" />;
}
