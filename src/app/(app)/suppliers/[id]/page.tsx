import { requirePageActor } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import type { RequestContext } from '@/lib/kernel/context';
import { redirect } from 'next/navigation';
import SupplierProfileClient from './SupplierProfileClient';

export const metadata = { title: 'Supplier profile' };

export default async function SupplierPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePageActor();
  try {
    await authorize({ actor, requestId: '', channel: 'WEB', idempotencyKey: null, ipAddress: null, userAgent: null, syncBatchId: null } satisfies RequestContext, { module: 'SUPPLIERS', action: 'VIEW' });
  } catch {
    redirect('/dashboard');
  }
  const { id } = await params;
  return <SupplierProfileClient id={id} />;
}
