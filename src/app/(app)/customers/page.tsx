import { requirePageActor } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import type { RequestContext } from '@/lib/kernel/context';
import { redirect } from 'next/navigation';
import CustomersClient from './CustomersClient';

export const metadata = { title: 'Customers' };

export default async function CustomersPage() {
  const actor = await requirePageActor();
  try {
    await authorize({ actor, requestId: '', channel: 'WEB', idempotencyKey: null, ipAddress: null, userAgent: null, syncBatchId: null } satisfies RequestContext, { module: 'CUSTOMERS', action: 'VIEW' });
  } catch {
    redirect('/dashboard');
  }
  return <CustomersClient />;
}
