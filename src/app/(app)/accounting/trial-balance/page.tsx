import { PageHeader } from '@/components/ui';
import TrialBalanceClient from './TrialBalanceClient';

export const metadata = { title: 'Trial Balance' };

export default function TrialBalancePage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Trial Balance"
        description="View debits and credits across all accounts at a point in time."
      />
      <TrialBalanceClient />
    </div>
  );
}