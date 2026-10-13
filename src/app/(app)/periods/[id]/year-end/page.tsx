import { requireContext, requirePageActor } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { prisma } from '@/lib/db/prisma';
import YearEndClient from './YearEndClient';

export default async function PeriodYearEndPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requirePageActor();
  const ctx = await requireContext();
  await authorize(ctx, { module: 'FINANCIAL_CLOSE', action: 'VIEW' });

  if (!ctx.actor.organizationId) {
    return <div>No organization context</div>;
  }

  const { id } = await params;

  const period = await prisma.financialPeriod.findFirst({
    where: { id, organizationId: ctx.actor.organizationId },
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      type: true,
      startDate: true,
      endDate: true,
    },
  });

  if (!period) {
    return <div>Period not found</div>;
  }

  if (period.type !== 'ANNUAL') {
    return <div>Year-end procedure is only available for ANNUAL periods.</div>;
  }

  const canRunYearEnd = actor.roleCodes.some((r) => r === 'FINANCIAL_CLOSE.APPROVE' || r === 'CEO');

  return (
    <div className="space-y-6">
      <YearEndClient
        actor={actor}
        period={period}
        canRunYearEnd={canRunYearEnd}
      />
    </div>
  );
}