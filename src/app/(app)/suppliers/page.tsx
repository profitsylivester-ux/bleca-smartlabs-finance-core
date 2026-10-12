import { requirePageActor } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import type { RequestContext } from '@/lib/kernel/context';
import { redirect } from 'next/navigation';
import SuppliersClient from './SuppliersClient';

export const metadata = { title: 'Suppliers' };

export default async function SuppliersPage() {
  const actor = await requirePageActor();
  try {
    await authorize({ actor, requestId: '', channel: 'WEB', idempotencyKey: null, ipAddress: null, userAgent: null, syncBatchId: null } satisfies RequestContext, { module: 'SUPPLIERS', action: 'VIEW' });
  } catch {
    redirect('/dashboard');
  }
  return <SuppliersClient />;
}
