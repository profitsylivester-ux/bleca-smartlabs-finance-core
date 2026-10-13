import { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { prisma } from '@/lib/db/prisma';
import { ValidationError } from '@/lib/kernel/errors';

const dismissSchema = z.object({
  reason: z.string().min(5).max(2000),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'ANOMALY_DETECTION', action: 'EDIT' });

    const { id } = await params;
    const body = dismissSchema.parse(await request.json());

    const flag = await prisma.anomalyFlag.findFirst({
      where: { id, organizationId: ctx.actor.organizationId ?? undefined },
    });
    if (!flag) return apiError(new ValidationError('Anomaly flag was not found.'), reqId);

    await withAudit(
      {
        organizationId: flag.organizationId,
        actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
        requestId: reqId,
      },
      async (tx) => {
        await tx.anomalyFlag.update({
          where: { id },
          data: {
            status: 'DISMISSED',
            dismissedAt: new Date(),
            dismissedById: ctx.actor.userId,
            dismissReason: body.reason.trim(),
          },
        });

        await writeAuditEntry(
          tx,
          { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
          {
            action: 'ANOMALY_FLAG_DISMISSED',
            entityType: 'ANOMALY_FLAG',
            entityId: id,
            entityLabel: flag.entityLabel,
            description: `Dismissed anomaly ${flag.anomalyType}: ${body.reason.trim()}`,
            metadata: { status: 'DISMISSED', dismissedAt: new Date().toISOString(), dismissedById: ctx.actor.userId, dismissReason: body.reason.trim() },
          },
          { organizationId: flag.organizationId, requestId: reqId },
        );
      },
    );

    return ok({ data: { id, status: 'DISMISSED' } }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}