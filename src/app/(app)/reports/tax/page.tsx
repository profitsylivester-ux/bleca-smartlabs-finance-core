import TaxReportClient from './TaxReportClient';
import { requireTaxReportActor } from '@/lib/tax-compliance/page-access';

export const metadata = { title: 'Tax Report' };
export default async function TaxReportPage() {
  await requireTaxReportActor();
  return <TaxReportClient />;
}
