import { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { prisma } from '@/lib/db/prisma';
import { ValidationError } from '@/lib/kernel/errors';

const readAllSchema = z.object({
  category: z.string().optional(),
});

export async function POST(request: NextRequest) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'NOTIFICATIONS', action: 'VIEW' });

    const body = readAllSchema.parse(await request.json().catch(() => ({})));

    const where: Record<string, unknown> = {
      userId: ctx.actor.userId,
      status: { in: ['PENDING', 'SENT', 'DELIVERED'] },
    };
    if (body.category) where.category = body.category;

    const notifications = await prisma.notification.findMany({
      where,
      select: { id: true, title: true },
    });

    if (notifications.length === 0) {
      return ok({ data: { count: 0 } }, 200, reqId);
    }

    await withAudit(
      {
        organizationId: ctx.actor.organizationId!,
        actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
        requestId: reqId,
      },
      async (tx) => {
        await tx.notification.updateMany({
          where,
          data: { status: 'READ', readAt: new Date() },
        });

        await writeAuditEntry(
          tx,
          { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
          {
            action: 'NOTIFICATION_READ',
            entityType: 'NOTIFICATION',
            entityId: 'bulk',
            entityLabel: `Marked ${notifications.length} notifications as read`,
            description: `Marked ${notifications.length} notification(s) as read${body.category ? ` in category ${body.category}` : ''}`,
            metadata: { count: notifications.length, category: body.category ?? null },
          },
          { organizationId: ctx.actor.organizationId!, requestId: reqId },
        );
      },
    );

    return ok({ data: { count: notifications.length } }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}