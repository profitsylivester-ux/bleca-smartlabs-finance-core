import ComplianceReportClient from './ComplianceReportClient';
import { requireTaxReportActor } from '@/lib/tax-compliance/page-access';

export const metadata = { title: 'Compliance Report' };
export default async function ComplianceReportPage() {
  await requireTaxReportActor();
  return <ComplianceReportClient />;
}
