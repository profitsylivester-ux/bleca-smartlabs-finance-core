import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { AnomaliesClient } from './AnomaliesClient';

export const metadata: Metadata = { title: 'Anomaly flags' };

export default async function AnomaliesPage() {
  const ctx = await requireContext();
  await authorize(ctx, { module: 'ANOMALY_DETECTION', action: 'VIEW' });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Anomaly flags"
        description="Deterministic rule-based flags for review. No auto-block, no auto-reject — every transition is audited."
      />
      <AnomaliesClient />
    </div>
  );
}