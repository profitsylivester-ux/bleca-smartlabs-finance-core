import type { Metadata } from 'next';
import { requireContext, requirePageActor } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { prisma } from '@/lib/db/prisma';
import MasterDataHistoryClient from './MasterDataHistoryClient';

export const metadata: Metadata = { title: 'Master Data Change History' };

export default async function MasterDataHistoryPage() {
  const actor = await requirePageActor();
  const ctx = await requireContext();
  await authorize(ctx, { module: 'MASTER_DATA', action: 'VIEW' });

  if (!ctx.actor.organizationId) {
    return <div>No organization context</div>;
  }

  const [changeRequestsRaw, versionsRaw] = await Promise.all([
    prisma.masterDataChangeRequest.findMany({
      where: { organizationId: ctx.actor.organizationId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        entityType: true,
        entityId: true,
        proposedChanges: true,
        reason: true,
        status: true,
        requestedById: true,
        approvedById: true,
        approvedAt: true,
        effectiveDate: true,
        expiresAt: true,
        createdAt: true,
        updatedAt: true,
        requestedBy: { select: { id: true, fullName: true, email: true } },
        approvedBy: { select: { id: true, fullName: true, email: true } },
      },
    }),
    prisma.masterDataVersion.findMany({
      where: {
        changeRequest: { organizationId: ctx.actor.organizationId },
      },
      orderBy: { effectiveFrom: 'desc' },
      select: {
        id: true,
        changeRequestId: true,
        entityType: true,
        entityId: true,
        versionNumber: true,
        snapshot: true,
        changedFields: true,
        effectiveFrom: true,
        effectiveTo: true,
        createdAt: true,
        changeRequest: {
          select: {
            id: true,
            entityType: true,
            status: true,
            reason: true,
            requestedBy: { select: { fullName: true } },
          },
        },
      },
    }),
  ]);

  const changeRequests = changeRequestsRaw.map((cr) => ({
    ...cr,
    proposedChanges: cr.proposedChanges as Record<string, unknown>,
    effectiveDate: cr.effectiveDate?.toISOString() ?? null,
    expiresAt: cr.expiresAt?.toISOString() ?? null,
    approvedAt: cr.approvedAt?.toISOString() ?? null,
    createdAt: cr.createdAt.toISOString(),
    updatedAt: cr.updatedAt.toISOString(),
  }));

  const versions = versionsRaw.map((v) => ({
    ...v,
    snapshot: v.snapshot as Record<string, unknown>,
    changedFields: v.changedFields as Record<string, unknown> | null,
    effectiveFrom: v.effectiveFrom.toISOString(),
    effectiveTo: v.effectiveTo?.toISOString() ?? null,
    createdAt: v.createdAt.toISOString(),
  }));

  return <MasterDataHistoryClient initialData={{ changeRequests, versions }} />;
}