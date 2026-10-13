import { prisma } from '@/lib/db/prisma';
import type { DispatchInput } from './types';
import { sendMail } from './email';

/**
 * Notification dispatch (M16, PDF §46).
 *
 * IN_APP is always written (dedupeKey via skipDuplicates prevents storms).
 * EMAIL is attempted only when the user has it enabled for the category AND
 * quiet hours (if set) do not apply. Failures never throw — a notification
 * must never break the business transaction that raised it.
 */

export function isQuietHours(now: Date, start: string | null, end: string | null): boolean {
  if (!start || !end) return false;
  const hhmm = now.toISOString().slice(11, 16);
  if (start <= end) return hhmm >= start && hhmm < end;
  return hhmm >= start || hhmm < end;
}

export async function dispatch(input: DispatchInput): Promise<void> {
  const channel = input.channel ?? 'IN_APP';
  await prisma.notification.createMany({
    data: [
      {
        organizationId: input.organizationId,
        userId: input.userId,
        category: input.category,
        severity: input.severity ?? 'INFO',
        channel: 'IN_APP',
        status: 'PENDING',
        title: input.title,
        body: input.body,
        actionUrl: input.actionUrl,
        dedupeKey: input.dedupeKey,
      },
    ],
    skipDuplicates: true,
  });

  if (channel !== 'EMAIL' || !input.emailTo) return;

  const prefs = await prisma.notificationPreference.findMany({
    where: { userId: input.userId, category: input.category, channel: 'EMAIL' },
    select: { enabled: true, quietHoursStart: true, quietHoursEnd: true },
  });
  if (prefs.length > 0 && prefs.every((p) => !p.enabled)) return;
  const quiet = prefs.find((p) => p.quietHoursStart && p.quietHoursEnd);
  if (quiet && isQuietHours(new Date(), quiet.quietHoursStart, quiet.quietHoursEnd)) return;

  try {
    await sendMail({
      to: input.emailTo,
      subject: input.emailSubject ?? input.title,
      text: `${input.title}\n\n${input.body}${input.actionUrl ? `\n\nOpen: ${input.actionUrl}` : ''}`,
    });
    await prisma.notification.createMany({
      data: [
        {
          organizationId: input.organizationId,
          userId: input.userId,
          category: input.category,
          severity: input.severity ?? 'INFO',
          channel: 'EMAIL',
          status: 'SENT',
          title: input.title,
          body: input.body,
          actionUrl: input.actionUrl,
          dedupeKey: input.dedupeKey ? `${input.dedupeKey}:email` : undefined,
        },
      ],
      skipDuplicates: true,
    });
  } catch {
    return;
  }
}
