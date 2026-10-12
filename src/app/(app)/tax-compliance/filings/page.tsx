import FilingsClient from './FilingsClient';
import { requireTaxPageActor } from '@/lib/tax-compliance/page-access';

export const metadata = { title: 'Filings' };
export default async function FilingsPage() {
  await requireTaxPageActor();
  return <FilingsClient />;
}
