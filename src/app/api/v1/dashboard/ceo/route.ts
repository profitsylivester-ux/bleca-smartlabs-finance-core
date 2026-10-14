import { NextRequest } from 'next/server';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { getCeoDashboard } from '@/lib/dashboards/ceo';

export async function GET(request: NextRequest) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'DASHBOARD_CEO', action: 'VIEW' });

    const figures = await getCeoDashboard(ctx);

    await withAudit(
      {
        organizationId: ctx.actor.organizationId!,
        actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
        requestId: reqId,
      },
      async (tx) => {
        await writeAuditEntry(
          tx,
          { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
          {
            action: 'REPORT_GENERATED',
            entityType: 'REPORT',
            entityId: 'CEO_DASHBOARD',
            description: 'Viewed CEO dashboard',
            metadata: { currency: figures.currency, generatedAt: figures.generatedAt },
          },
          { organizationId: ctx.actor.organizationId!, requestId: reqId },
        );
      },
    );

    return ok({ data: figures }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
