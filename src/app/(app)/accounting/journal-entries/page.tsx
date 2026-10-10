import { PageHeader, Card, CardHeader, CardBody, Table, Th, Td, Badge, Button, Input, EmptyState, Alert } from '@/components/ui';
import { formatAmount, formatDate, shortId } from '@/lib/format';
import JournalEntriesClient from './JournalEntriesClient';

export const metadata = { title: 'Journal Entries' };

export default async function JournalEntriesPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Journal Entries"
        description="Create, review and post double-entry journal entries."
        actions={<Button size="sm">New Entry</Button>}
      />
      <JournalEntriesClient />
    </div>
  );
}