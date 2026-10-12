import { requirePageActor } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import type { RequestContext } from '@/lib/kernel/context';
import { redirect } from 'next/navigation';
import SupplierBankDetailsClient from './SupplierBankDetailsClient';

export const metadata = { title: 'Supplier bank details' };

export default async function SupplierBankDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePageActor();
  try {
    await authorize({ actor, requestId: '', channel: 'WEB', idempotencyKey: null, ipAddress: null, userAgent: null, syncBatchId: null } satisfies RequestContext, { module: 'SUPPLIERS', action: 'VIEW' });
  } catch {
    redirect('/dashboard');
  }
  const { id } = await params;
  return <SupplierBankDetailsClient id={id} />;
}
