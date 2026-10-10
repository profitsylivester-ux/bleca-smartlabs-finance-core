import { Metadata } from 'next';
import { requirePageActor } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import type { RequestContext } from '@/lib/kernel/context';
import { redirect } from 'next/navigation';
import AdjustTransactionClient from './AdjustTransactionClient';

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return { title: `Adjust Transaction ${id}` };
}

export default async function AdjustTransactionPage({ params }: Props) {
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
      { module: 'TRANSACTIONS', action: 'EDIT' }
    );
  } catch {
    redirect('/dashboard');
  }

  const { id } = await params;
  return (
    <div className="space-y-6">
      <AdjustTransactionClient transactionId={id} />
    </div>
  );
}