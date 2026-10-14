import { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { prisma } from '@/lib/db/prisma';
import { ValidationError } from '@/lib/kernel/errors';

const notificationQuerySchema = z.object({
  unreadOnly: z.coerce.boolean().default(false),
  category: z.string().optional(),
});

const createNotificationSchema = z.object({
  userId: z.string().cuid(),
  category: z.string(),
  severity: z.enum(['INFO', 'SUCCESS', 'WARNING', 'CRITICAL']).default('INFO'),
  channel: z.enum(['IN_APP', 'EMAIL', 'SMS', 'PUSH']).default('IN_APP'),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
  actionUrl: z.string().url().optional().nullable(),
  entityType: z.string().optional().nullable(),
  entityId: z.string().optional().nullable(),
  dedupeKey: z.string().optional().nullable(),
  emailTo: z.string().email().optional().nullable(),
  emailSubject: z.string().optional().nullable(),
});

export async function GET(request: NextRequest) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'NOTIFICATIONS', action: 'VIEW' });

    const { searchParams } = new URL(request.url);
    const params = notificationQuerySchema.parse(Object.fromEntries(searchParams));

    const rows = await prisma.notification.findMany({
      where: {
        userId: ctx.actor.userId,
        ...(ctx.actor.organizationId ? { organizationId: ctx.actor.organizationId } : {}),
        ...(params.unreadOnly ? { status: { in: ['PENDING', 'SENT', 'DELIVERED'] } } : {}),
        ...(params.category ? { category: params.category as never } : {}),
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

export async function POST(request: NextRequest) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'NOTIFICATIONS', action: 'CREATE' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const body = createNotificationSchema.parse(await request.json());

    const targetUser = await prisma.user.findUnique({
      where: { id: body.userId },
      select: { id: true, emailNormalized: true, fullName: true, organizationMemberships: { where: { organizationId: ctx.actor.organizationId }, select: { organizationId: true } } },
    });
    if (!targetUser || targetUser.organizationMemberships.length === 0) {
      return apiError(new ValidationError('Target user not found in this organization'), reqId);
    }

    await withAudit(
      {
        organizationId: ctx.actor.organizationId,
        actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
        requestId: reqId,
      },
      async (tx) => {
        await tx.notification.createMany({
          data: [
            {
              organizationId: ctx.actor.organizationId,
              userId: body.userId,
              category: body.category as never,
              severity: body.severity,
              channel: 'IN_APP',
              status: 'PENDING',
              title: body.title,
              body: body.body,
              actionUrl: body.actionUrl,
              dedupeKey: body.dedupeKey,
            },
          ],
          skipDuplicates: true,
        });

        if (body.channel === 'EMAIL' && body.emailTo) {
          await tx.notification.createMany({
            data: [
              {
                organizationId: ctx.actor.organizationId,
                userId: body.userId,
                category: body.category as never,
                severity: body.severity,
                channel: 'EMAIL',
                status: 'PENDING',
                title: body.title,
                body: body.body,
                actionUrl: body.actionUrl,
                dedupeKey: body.dedupeKey ? `${body.dedupeKey}:email` : undefined,
              },
            ],
            skipDuplicates: true,
          });
        }

        await writeAuditEntry(
          tx,
          { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
          {
            action: 'DOCUMENT_UPLOADED',
            entityType: 'NOTIFICATION',
            entityId: body.dedupeKey ?? 'new',
            entityLabel: body.title,
            description: `Created notification for ${targetUser.fullName}: ${body.title}`,
            metadata: { category: body.category, severity: body.severity, channel: body.channel },
          },
          { organizationId: ctx.actor.organizationId, requestId: reqId },
        );
      },
    );

    return ok({ data: { success: true } }, 201, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
