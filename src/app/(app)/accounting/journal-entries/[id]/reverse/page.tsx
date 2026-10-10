import { PageHeader, Button } from '@/components/ui';
import { Metadata } from 'next';
import ReverseJournalEntryClient from './ReverseJournalEntryClient';

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return { title: `Reverse Journal Entry ${id}` };
}

export default async function ReverseJournalEntryPage({ params }: Props) {
  const { id } = await params;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Reverse Journal Entry"
        description="Create a reversal entry for a posted or locked journal entry."
        actions={<Button variant="ghost" onClick={() => window.history.back()}>Cancel</Button>}
      />
      <ReverseJournalEntryClient entryId={id} />
    </div>
  );
}