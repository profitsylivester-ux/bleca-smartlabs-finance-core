import { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { runAnomalyScan } from '@/lib/anomaly/service';
import { ValidationError } from '@/lib/kernel/errors';

const scanSchema = z.object({
  force: z.coerce.boolean().default(false),
});

export async function POST(request: NextRequest) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'ANOMALY_DETECTION', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const body = scanSchema.parse(await request.json().catch(() => ({})));

    const result = await runAnomalyScan(ctx);

    await withAudit(
      {
        organizationId: ctx.actor.organizationId,
        actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
        requestId: reqId,
      },
      async (tx) => {
        await writeAuditEntry(
          tx,
          { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
          {
            action: 'ANOMALY_SCAN_COMPLETED',
            entityType: 'ANOMALY_FLAG',
            entityId: reqId,
            description: `Anomaly scan completed: ${result.flagsCreated} new flags from ${result.rulesRun.length} rules`,
            metadata: { ...result, force: body.force },
          },
          { organizationId: ctx.actor.organizationId, requestId: reqId },
        );
      },
    );

    return ok({ data: result }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
