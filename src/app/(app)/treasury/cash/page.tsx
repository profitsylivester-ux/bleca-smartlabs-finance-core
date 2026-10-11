import { requirePageActor } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import type { RequestContext } from '@/lib/kernel/context';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db/prisma';
import TreasuryAccountActions from '../TreasuryAccountActions';

export const metadata = { title: 'Cash Accounts' };

export default async function CashAccountsPage() {
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

  const accounts = await prisma.treasuryAccount.findMany({
    where: { organizationId: actor.organizationId!, kind: 'CASH' },
    orderBy: { code: 'asc' },
    select: {
      id: true,
      code: true,
      name: true,
      kind: true,
      currencyCode: true,
      isActive: true,
      isRestricted: true,
    },
  });

  return (
    <div className="space-y-6">
      <TreasuryAccountActions accounts={accounts} kind="CASH" actor={actor} />
    </div>
  );
}