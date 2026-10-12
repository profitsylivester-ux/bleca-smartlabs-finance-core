import { redirect } from 'next/navigation';
import { requirePageActor } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import type { RequestContext } from '@/lib/kernel/context';

export async function requireTaxPageActor() {
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
    } satisfies RequestContext, { module: 'TAX_COMPLIANCE', action: 'VIEW' });
  } catch {
    redirect('/dashboard');
  }
  return actor;
}

export async function requireTaxReportActor() {
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
    } satisfies RequestContext, { module: 'REPORTS', action: 'VIEW' });
  } catch {
    redirect('/dashboard');
  }
  return actor;
}
