import { requirePageActor } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import type { RequestContext } from '@/lib/kernel/context';
import { redirect } from 'next/navigation';
import TreasuryAccountDetailClient from './TreasuryAccountDetailClient';

export const metadata = { title: 'Treasury Account Detail' };

export default async function TreasuryAccountDetailPage({
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
      { module: 'TREASURY_TRANSFERS', action: 'VIEW' }
    );
  } catch {
    redirect('/dashboard');
  }

  return (
    <div className="space-y-6">
      <TreasuryAccountDetailClient actor={actor} params={params} />
    </div>
  );
}