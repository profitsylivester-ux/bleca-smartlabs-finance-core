import SalesRegister from '../SalesRegister';
import { requireSalesPageActor } from '@/lib/sales/page-access';
export const metadata = { title: 'Invoices' };
export default async function InvoicesPage() {
  await requireSalesPageActor('INVOICES');
  return <SalesRegister kind="invoices" />;
}
