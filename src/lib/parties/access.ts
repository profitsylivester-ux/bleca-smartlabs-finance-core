import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';
import type { PermissionAction } from '@/lib/kernel/context';

export async function requirePartyAccess(
  ctx: Awaited<ReturnType<typeof requireContext>>,
  partyId: string,
  action: PermissionAction,
) {
  if (!ctx.actor.organizationId) throw new ValidationError('No organization context');
  const party = await prisma.party.findFirst({
    where: { id: partyId, organizationId: ctx.actor.organizationId, deletedAt: null },
    select: { id: true, customer: { select: { id: true } }, supplier: { select: { id: true } } },
  });
  if (!party || (!party.customer && !party.supplier)) throw new NotFoundError('Party', partyId);
  if (party.customer) await authorize(ctx, { module: 'CUSTOMERS', action });
  if (party.supplier) await authorize(ctx, { module: 'SUPPLIERS', action });
  return party;
}
