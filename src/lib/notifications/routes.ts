import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { prisma } from '@/lib/db/prisma';
import { ValidationError } from '@/lib/kernel/errors';

/** GET /api/v1/notifications — my inbox. POST /notifications/:id/read — mark read. */

export async function GET(request: NextRequest) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'NOTIFICATIONS', action: 'VIEW' });
    const { searchParams } = new URL(request.url);
    const unreadOnly = searchParams.get('unreadOnly') === 'true';
    const category = searchParams.get('category');
    const rows = await prisma.notification.findMany({
      where: {
        userId: ctx.actor.userId,
        ...(ctx.actor.organizationId ? { organizationId: ctx.actor.organizationId } : {}),
        ...(unreadOnly ? { status: { in: ['PENDING', 'SENT', 'DELIVERED'] } } : {}),
        ...(category ? { category: category as never } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const unread = await prisma.notification.count({
      where: { userId: ctx.actor.userId, status: { in: ['PENDING', 'SENT', 'DELIVERED'] } },
    });
    return ok({ data: rows, unread }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

const readSchema = z.object({});

export async function markRead(request: NextRequest, id: string) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'NOTIFICATIONS', action: 'VIEW' });
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
