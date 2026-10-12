import SalesRegister from '../SalesRegister';
import { requireSalesPageActor } from '@/lib/sales/page-access';
export const metadata = { title: 'Debit notes' };
export default async function DebitNotesPage() {
  await requireSalesPageActor('DEBIT_NOTES');
  return <SalesRegister kind="debit-notes" />;
}
