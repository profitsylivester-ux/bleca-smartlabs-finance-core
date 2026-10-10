import { PageHeader } from '@/components/ui';
import CashFlowClient from './CashFlowClient';

export const metadata = { title: 'Cash Flow Statement' };

export default function CashFlowPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Cash Flow Statement"
        description="View cash flows from operating, investing, and financing activities."
      />
      <CashFlowClient />
    </div>
  );
}