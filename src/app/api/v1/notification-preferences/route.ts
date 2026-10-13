import { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { prisma } from '@/lib/db/prisma';
import { ValidationError } from '@/lib/kernel/errors';

const preferenceSchema = z.object({
  category: z.string(),
  channel: z.enum(['IN_APP', 'EMAIL', 'SMS', 'PUSH']),
  enabled: z.boolean().default(true),
  quietHoursStart: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional().nullable(),
  quietHoursEnd: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional().nullable(),
});

const updateSchema = z.object({
  preferences: z.array(preferenceSchema).min(1),
});

export async function GET(request: NextRequest) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'NOTIFICATIONS', action: 'VIEW' });

    const prefs = await prisma.notificationPreference.findMany({
      where: { userId: ctx.actor.userId },
      orderBy: [{ category: 'asc' }, { channel: 'asc' }],
    });

    return ok({ data: prefs }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function PATCH(request: NextRequest) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'NOTIFICATIONS', action: 'EDIT' });

    const body = updateSchema.parse(await request.json());

    await withAudit(
      {
        organizationId: ctx.actor.organizationId!,
        actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
        requestId: reqId,
      },
      async (tx) => {
        for (const pref of body.preferences) {
          await tx.notificationPreference.upsert({
            where: {
              userId_category_channel: {
                userId: ctx.actor.userId,
                category: pref.category as never,
                channel: pref.channel,
              },
            },
            create: {
              userId: ctx.actor.userId,
              category: pref.category as never,
              channel: pref.channel,
              enabled: pref.enabled,
              quietHoursStart: pref.quietHoursStart,
              quietHoursEnd: pref.quietHoursEnd,
            },
            update: {
              enabled: pref.enabled,
              quietHoursStart: pref.quietHoursStart,
              quietHoursEnd: pref.quietHoursEnd,
            },
          });
        }

        await writeAuditEntry(
          tx,
          { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
          {
            action: 'CONFIGURATION_CHANGES',
            entityType: 'NOTIFICATION',
            entityId: ctx.actor.userId,
            entityLabel: 'Notification preferences',
            description: `Updated notification preferences (${body.preferences.length} items)`,
            metadata: { count: body.preferences.length },
          },
          { organizationId: ctx.actor.organizationId!, requestId: reqId },
        );
      },
    );

    const updated = await prisma.notificationPreference.findMany({
      where: { userId: ctx.actor.userId },
      orderBy: [{ category: 'asc' }, { channel: 'asc' }],
    });

    return ok({ data: updated }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}