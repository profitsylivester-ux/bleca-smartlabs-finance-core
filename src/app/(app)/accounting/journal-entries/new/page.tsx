import { PageHeader, Card, CardHeader, CardBody, Button } from '@/components/ui';
import NewJournalEntryClient from './NewJournalEntryClient';

export const metadata = { title: 'New Journal Entry' };

export default function NewJournalEntryPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="New Journal Entry"
        description="Create a double-entry journal entry with at least two lines."
        actions={<Button variant="ghost" onClick={() => window.history.back()}>Cancel</Button>}
      />
      <NewJournalEntryClient />
    </div>
  );
}