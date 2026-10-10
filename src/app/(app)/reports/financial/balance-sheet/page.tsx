import { PageHeader } from '@/components/ui';
import BalanceSheetClient from './BalanceSheetClient';

export const metadata = { title: 'Balance Sheet' };

export default function BalanceSheetPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Balance Sheet"
        description="View assets, liabilities, and equity at a point in time."
      />
      <BalanceSheetClient />
    </div>
  );
}