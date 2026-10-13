import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { NotificationsClient } from './NotificationsClient';

export const metadata: Metadata = { title: 'Notifications' };

export default async function NotificationsPage() {
  const ctx = await requireContext();
  await authorize(ctx, { module: 'NOTIFICATIONS', action: 'VIEW' });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notifications"
        description="Your inbox — approval requests, alerts, reminders and system messages."
      />
      <NotificationsClient />
    </div>
  );
}