import SalesCreateClient from '../../SalesCreateClient';
import { requireSalesPageActor } from '@/lib/sales/page-access';
export const metadata = { title: 'New quotation' };
export default async function NewQuotationPage() {
  await requireSalesPageActor('QUOTATIONS');
  return <SalesCreateClient kind="quotation" />;
}
