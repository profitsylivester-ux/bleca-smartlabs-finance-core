import SalesCreateClient from '../../SalesCreateClient';
import { requireSalesPageActor } from '@/lib/sales/page-access';
export const metadata = { title: 'New invoice' };
export default async function NewInvoicePage() {
  await requireSalesPageActor('INVOICES');
  return <SalesCreateClient kind="invoice" />;
}
