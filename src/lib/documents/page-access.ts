import { redirect } from 'next/navigation';
import { requirePageActor } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import type { RequestContext } from '@/lib/kernel/context';

export async function requireDocumentPageActor() {
  const actor = await requirePageActor();
  try {
    await authorize({
      actor,
      requestId: '',
      channel: 'WEB',
      idempotencyKey: null,
      ipAddress: null,
      userAgent: null,
      syncBatchId: null,
    } satisfies RequestContext, { module: 'DOCUMENTS', action: 'VIEW' });
  } catch {
    redirect('/dashboard');
  }
  return actor;
}
