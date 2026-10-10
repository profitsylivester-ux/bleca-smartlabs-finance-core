import { PageHeader, Button } from '@/components/ui';
import NewTransactionClient from './NewTransactionClient';

export const metadata = { title: 'New Transaction' };

export default function NewTransactionPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="New Transaction"
        description="Create a new transaction with all required fields."
        actions={<Button variant="ghost" onClick={() => window.history.back()}>Cancel</Button>}
      />
      <NewTransactionClient />
    </div>
  );
}