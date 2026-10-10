import { requirePageActor } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import type { RequestContext } from '@/lib/kernel/context';
import { redirect } from 'next/navigation';
import TransactionsClient from './TransactionsClient';

export const metadata = { title: 'Transactions' };

export default async function TransactionsPage() {
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
      { module: 'TRANSACTIONS', action: 'VIEW' }
    );
  } catch {
    redirect('/dashboard');
  }

  return (
    <div className="space-y-6">
      <TransactionsClient actor={actor} />
    </div>
  );
}