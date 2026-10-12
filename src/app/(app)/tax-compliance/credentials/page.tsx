import CredentialsClient from './CredentialsClient';
import { requireTaxPageActor } from '@/lib/tax-compliance/page-access';
import { prisma } from '@/lib/db/prisma';

export const metadata = { title: 'Credentials' };
export default async function CredentialsPage() {
  const actor = await requireTaxPageActor();
  const users = actor.organizationId
    ? await prisma.user.findMany({
        where: { isActive: true, organizationMemberships: { some: { organizationId: actor.organizationId } } },
        orderBy: { fullName: 'asc' },
        take: 100,
        select: { id: true, fullName: true },
      })
    : [];
  return <CredentialsClient users={users} />;
}
