import { PageHeader } from '@/components/ui';
import GeneralLedgerClient from './GeneralLedgerClient';

export const metadata = { title: 'General Ledger' };

export default function GeneralLedgerPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="General Ledger"
        description="View journal lines with running balances and dimension breakdown."
      />
      <GeneralLedgerClient />
    </div>
  );
}