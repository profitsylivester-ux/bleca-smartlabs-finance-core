import { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { prisma } from '@/lib/db/prisma';
import { ValidationError } from '@/lib/kernel/errors';

const readSchema = z.object({});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'NOTIFICATIONS', action: 'VIEW' });

    const { id } = await params;
    readSchema.parse(await request.json().catch(() => ({})));

    const existing = await prisma.notification.findFirst({
      where: { id, userId: ctx.actor.userId },
    });
    if (!existing) return apiError(new ValidationError('Notification was not found.'), reqId);

    await withAudit(
      {
        organizationId: existing.organizationId,
        actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
        requestId: reqId,
      },
      async (tx) => {
        await tx.notification.update({ where: { id }, data: { status: 'READ', readAt: new Date() } });
        await writeAuditEntry(
          tx,
          { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
          {
            action: 'NOTIFICATION_READ',
            entityType: 'NOTIFICATION',
            entityId: id,
            entityLabel: existing.title,
            description: `Read notification ${existing.title}`,
          },
          { organizationId: existing.organizationId, requestId: reqId },
        );
      },
    );

    return ok({ data: { id, status: 'READ' } }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}