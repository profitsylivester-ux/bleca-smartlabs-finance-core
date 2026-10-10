import { Metadata } from 'next';
import { requirePageActor } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import type { RequestContext } from '@/lib/kernel/context';
import { redirect } from 'next/navigation';
import TransactionDetailClient from './TransactionDetailClient';

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return { title: `Transaction ${id}` };
}

export default async function TransactionDetailPage({ params }: Props) {
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

  const { id } = await params;
  return (
    <div className="space-y-6">
      <TransactionDetailClient transactionId={id} />
    </div>
  );
}