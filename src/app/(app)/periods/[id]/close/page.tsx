import { requireContext, requirePageActor } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { prisma } from '@/lib/db/prisma';
import CloseClient from './CloseClient';

type ChecklistItem = {
  itemKey: string;
  label: string;
  isBlocking: boolean;
  isAutomated: boolean;
  status: string;
  computedValue?: string | null;
  confirmedById?: string | null;
  confirmedAt?: string | null;
  waivedById?: string | null;
  waivedAt?: string | null;
  waiverReason?: string | null;
  waiverApproverId?: string | null;
  waiverApprovedAt?: string | null;
};

type CloseSession = {
  id: string;
  periodId: string;
  status: string;
  checklistItems: ChecklistItem[];
  startedAt?: string | null;
  submittedAt?: string | null;
  signedOffAt?: string | null;
  approvalRequestId?: string | null;
} | null;

export default async function PeriodClosePage({
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

  // Fetch period, close state, and automated checks
  const [period, closeState] = await Promise.all([
    prisma.financialPeriod.findFirst({
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
    }),
    prisma.financialClose.findFirst({
      where: { periodId: id, organizationId: ctx.actor.organizationId },
      include: {
        checklistItems: { orderBy: { itemKey: 'asc' } },
      },
    }),
  ]);

  if (!period) {
    return <div>Period not found</div>;
  }

  // Transform closeState to match CloseClient expectations
  const close: CloseSession = closeState ? {
    id: closeState.id,
    periodId: closeState.periodId,
    status: closeState.status,
    startedAt: closeState.startedAt?.toISOString() ?? null,
    submittedAt: closeState.submittedAt?.toISOString() ?? null,
    signedOffAt: closeState.signedOffAt?.toISOString() ?? null,
    approvalRequestId: closeState.approvalRequestId ?? null,
    checklistItems: closeState.checklistItems.map(item => ({
      itemKey: item.itemKey,
      label: item.label,
      isBlocking: item.isBlocking,
      isAutomated: item.isAutomated,
      status: item.status,
      computedValue: item.computedValue ?? null,
      confirmedById: item.confirmedById ?? null,
      confirmedAt: item.confirmedAt?.toISOString() ?? null,
      waivedById: item.waivedById ?? null,
      waivedAt: item.waivedAt?.toISOString() ?? null,
      waiverReason: item.waiverReason ?? null,
      waiverApproverId: item.waiverApproverId ?? null,
      waiverApprovedAt: item.waiverApprovedAt?.toISOString() ?? null,
    })),
  } : null;

  // Check permissions for actions
  const canStartClose = actor.roleCodes.some((r) => r === 'FINANCIAL_CLOSE.CREATE' || r === 'CEO' || r === 'FINANCE_OFFICER');
  const canEditClose = actor.roleCodes.some((r) => r === 'FINANCIAL_CLOSE.EDIT' || r === 'CEO' || r === 'FINANCE_OFFICER');
  const canSubmitClose = actor.roleCodes.some((r) => r === 'FINANCIAL_CLOSE.SUBMIT' || r === 'CEO');
  const canSignOff = actor.roleCodes.some((r) => r === 'FINANCIAL_CLOSE.APPROVE' || r === 'CEO');
  const canRunYearEnd = actor.roleCodes.some((r) => r === 'FINANCIAL_CLOSE.APPROVE' || r === 'CEO');

  return (
    <div className="space-y-6">
      <CloseClient
        actor={actor}
        period={period}
        close={close}
        permissions={{
          canStartClose,
          canEditClose,
          canSubmitClose,
          canSignOff,
          canRunYearEnd,
        }}
      />
    </div>
  );
}