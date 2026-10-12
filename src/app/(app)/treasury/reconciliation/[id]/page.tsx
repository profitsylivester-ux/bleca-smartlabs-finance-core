import { requirePageActor } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import type { RequestContext } from '@/lib/kernel/context';
import { redirect } from 'next/navigation';
import WorkbenchClient from './WorkbenchClient';

export const metadata = { title: 'Reconciliation workbench' };

export default async function ReconciliationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
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

  const { id } = await params;

  return (
    <div className="space-y-6">
      <WorkbenchClient sessionId={id} actor={actor} />
    </div>
  );
}
