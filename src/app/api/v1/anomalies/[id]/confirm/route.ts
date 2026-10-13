import { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { prisma } from '@/lib/db/prisma';
import { ValidationError } from '@/lib/kernel/errors';

const confirmSchema = z.object({
  reason: z.string().min(5).max(2000).optional(),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'ANOMALY_DETECTION', action: 'EDIT' });

    const { id } = await params;
    const body = confirmSchema.parse(await request.json());

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
            status: 'CONFIRMED',
            confirmedAt: new Date(),
            confirmedById: ctx.actor.userId,
          },
        });

        const desc = body.reason
          ? `Confirmed anomaly ${flag.anomalyType} on ${flag.entityType} ${flag.entityLabel ?? flag.entityId} — ${body.reason.trim()}`
          : `Confirmed anomaly ${flag.anomalyType} on ${flag.entityType} ${flag.entityLabel ?? flag.entityId} — escalated for human follow-up`;

        await writeAuditEntry(
          tx,
          { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
          {
            action: 'ANOMALY_FLAG_CONFIRMED',
            entityType: 'ANOMALY_FLAG',
            entityId: id,
            entityLabel: flag.entityLabel,
            description: desc,
            metadata: { status: 'CONFIRMED', confirmedAt: new Date().toISOString(), confirmedById: ctx.actor.userId, reason: body.reason?.trim() ?? null },
          },
          { organizationId: flag.organizationId, requestId: reqId },
        );
      },
    );

    return ok({ data: { id, status: 'CONFIRMED' } }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}