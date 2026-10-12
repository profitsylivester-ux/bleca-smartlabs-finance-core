import { requirePageActor } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import type { RequestContext } from '@/lib/kernel/context';
import { redirect } from 'next/navigation';
import ReconciliationClient from './ReconciliationClient';

export const metadata = { title: 'Reconciliation' };

export default async function ReconciliationPage() {
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
      { module: 'RECONCILIATION', action: 'VIEW' }
    );
  } catch {
    redirect('/dashboard');
  }

  return (
    <div className="space-y-6">
      <ReconciliationClient actor={actor} />
    </div>
  );
}
