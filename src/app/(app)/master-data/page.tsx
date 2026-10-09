import { requireContext, requirePageActor } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { prisma } from '@/lib/db/prisma';
import MasterDataClient from './MasterDataClient';

export default async function MasterDataPage() {
  const actor = await requirePageActor();
  const ctx = await requireContext();
  await authorize(ctx, { module: 'MASTER_DATA', action: 'VIEW' });

  if (!ctx.actor.organizationId) {
    return <div>No organization context</div>;
  }

  const [locations, departments, costCentres] = await Promise.all([
    prisma.location.findMany({
      where: { organizationId: ctx.actor.organizationId },
      orderBy: [{ type: 'asc' }, { code: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        type: true,
        isOwned: true,
        permissionReference: true,
        parentId: true,
        timezone: true,
        isActive: true,
        parent: { select: { id: true, code: true, name: true } },
        children: { select: { id: true, code: true, name: true } },
        _count: { select: { users: true } },
      },
    }),
    prisma.department.findMany({
      where: { organizationId: ctx.actor.organizationId },
      orderBy: [{ code: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        parentId: true,
        isActive: true,
        parent: { select: { id: true, code: true, name: true } },
        children: { select: { id: true, code: true, name: true } },
        _count: { select: { users: true, costCentres: true } },
      },
    }),
    prisma.costCentre.findMany({
      where: { organizationId: ctx.actor.organizationId },
      orderBy: [{ code: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        departmentId: true,
        isActive: true,
        department: { select: { id: true, code: true, name: true } },
      },
    }),
  ]);

  return <MasterDataClient initialData={{ locations, departments, costCentres }} />;
}