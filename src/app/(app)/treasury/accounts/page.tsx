import { requirePageActor } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import type { RequestContext } from '@/lib/kernel/context';
import { redirect } from 'next/navigation';
import TreasuryAccountsClient from './TreasuryAccountsClient';

export const metadata = { title: 'Treasury Accounts' };

export default async function TreasuryAccountsPage() {
  const actor = await requirePageActor();
  try {
    await authorize(
      {
        actor,
        requestId: '',
        channel: 'WEB',
        idempotencyKey: null,
        ipAddress: null,
        userAgent: null,
        syncBatchId: null,
      } satisfies RequestContext,
      { module: 'TREASURY_TRANSFERS', action: 'VIEW' }
    );
  } catch {
    redirect('/dashboard');
  }

  return (
    <div className="space-y-6">
      <TreasuryAccountsClient actor={actor} />
    </div>
  );
}