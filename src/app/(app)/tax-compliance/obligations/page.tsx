import ObligationsClient from './ObligationsClient';
import { requireTaxPageActor } from '@/lib/tax-compliance/page-access';

export const metadata = { title: 'Tax Obligations' };
export default async function ObligationsPage() {
  await requireTaxPageActor();
  return <ObligationsClient />;
}
