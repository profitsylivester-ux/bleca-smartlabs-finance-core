import TaxRulesClient from './TaxRulesClient';
import { requireTaxPageActor } from '@/lib/tax-compliance/page-access';

export const metadata = { title: 'Tax Rules' };
export default async function TaxRulesPage() {
  await requireTaxPageActor();
  return <TaxRulesClient />;
}
