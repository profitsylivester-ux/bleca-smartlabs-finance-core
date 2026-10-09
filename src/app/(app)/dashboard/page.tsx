import { redirect } from 'next/navigation';
import { requirePageActor, requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';

/**
 * The dashboard root only routes. Each role has a different landing page
 * because CEO and Finance Officer answer different questions (PDF 61): the CEO
 * looks at position and risk, the Finance Officer at what is waiting to be done.
 */
export default async function DashboardPage() {
  const actor = await requirePageActor();
  const ctx = await requireContext();

  await authorize(ctx, { module: 'DASHBOARD_CEO', action: 'VIEW' });
  await authorize(ctx, { module: 'DASHBOARD_FINANCE', action: 'VIEW' });

  redirect(actor.isFinalApprover ? '/dashboard/ceo' : '/dashboard/finance');
}
