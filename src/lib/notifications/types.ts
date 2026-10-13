import type {
  NotificationCategory,
  NotificationChannel,
  NotificationSeverity,
} from '@/generated/prisma/client';

/** Dispatch payload. `channel` defaults to IN_APP; EMAIL via the mail adapter. */
export interface DispatchInput {
  organizationId: string;
  userId: string;
  category: NotificationCategory;
  severity?: NotificationSeverity;
  channel?: NotificationChannel;
  title: string;
  body: string;
  actionUrl?: string;
  entityType?: string;
  entityId?: string;
  dedupeKey?: string;
  emailTo?: string;
  emailSubject?: string;
}
