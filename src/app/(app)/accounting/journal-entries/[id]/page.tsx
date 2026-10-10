import { PageHeader, Button } from '@/components/ui';
import { Metadata } from 'next';
import JournalEntryDetailClient from './JournalEntryDetailClient';

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return { title: `Journal Entry ${id}` };
}

export default async function JournalEntryDetailPage({ params }: Props) {
  const { id } = await params;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Journal Entry Detail"
        description="View journal entry lines, audit trail, and status timeline."
      />
      <JournalEntryDetailClient entryId={id} />
    </div>
  );
}