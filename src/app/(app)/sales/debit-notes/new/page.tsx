import SalesCreateClient from '../../SalesCreateClient';
import { requireSalesPageActor } from '@/lib/sales/page-access';
export const metadata = { title: 'New debit note' };
export default async function NewDebitNotePage() {
  await requireSalesPageActor('DEBIT_NOTES');
  return <SalesCreateClient kind="debit-note" />;
}
