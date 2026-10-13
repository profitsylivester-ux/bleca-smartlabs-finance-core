import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { PreferencesClient } from './PreferencesClient';

export const metadata: Metadata = { title: 'Notification preferences' };

export default async function NotificationPreferencesPage() {
  const ctx = await requireContext();
  await authorize(ctx, { module: 'NOTIFICATIONS', action: 'VIEW' });

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader
        title="Notification preferences"
        description="Choose how and when you receive notifications for each category."
      />
      <PreferencesClient />
    </div>
  );
}