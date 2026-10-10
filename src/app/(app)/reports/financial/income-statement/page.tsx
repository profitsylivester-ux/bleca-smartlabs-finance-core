import { PageHeader } from '@/components/ui';
import IncomeStatementClient from './IncomeStatementClient';

export const metadata = { title: 'Income Statement' };

export default function IncomeStatementPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Income Statement"
        description="View revenue, expenses, and net surplus/deficit for a period."
      />
      <IncomeStatementClient />
    </div>
  );
}