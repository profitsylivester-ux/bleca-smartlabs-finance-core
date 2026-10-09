import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/nxt-auth';
import { requirePageActor } from '@/lib/auth/guard';
import { AppShell } from '@/components/app-shell';
import { prisma } from '@/lib/db/prisma';
import { loadEffectivePermissions } from '@/lib/rbac/permissions';
import { MODULES, GROUPS } from '@/modules/module-registry';

/**
 * Every page in this shell reads the session cookie and the database.
 *
 * `instant = false` says so explicitly rather than letting the prerenderer
 * discover it and fail the build. It is the correct setting for this whole
 * subtree, not a workaround: none of these pages can be statically generated,
 * because who is signed in and what they may see are both per-request facts.
 */
export const instant = false;

/**
 * The authenticated shell (PDF 74's "nine substrates" made visible).
 *
 * Navigation is derived from the module registry AND the actor's real server-side
 * permissions. A module the actor cannot see is not rendered, and a module that
 * exists in the registry but is not built yet is rendered as an honest
 * "not yet available" row rather than a link to a 404.
 *
 * Note what is NOT here: no client-side permission store. Each render resolves
 * permissions again from the database, because the same decision made from a
 * cached list would be a decision made from stale data.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  if (!session?.user?.id) {
    redirect('/login');
  }
  if (!session.mfaSatisfied) {
    redirect('/mfa-verify');
  }

  const actor = await requirePageActor();
  const effective = await loadEffectivePermissions(actor.userId);

  const grantedKeys = new Set<string>();
  for (const p of effective.permissions) {
    if (p.action === 'VIEW') grantedKeys.add(p.module);
  }

  const unreadNotifications = await prisma.notification.count({
    where: { userId: actor.userId, status: { in: ['PENDING', 'SENT', 'DELIVERED'] } },
  });

  const groups = GROUPS.map((group) => ({
    ...group,
    modules: MODULES.filter((m) => m.group === group.key).sort((a, b) => a.order - b.order),
  })).filter((g) => g.modules.length > 0);

  return (
    <AppShell
      actor={{
        fullName: actor.fullName,
        email: actor.email,
        roleCodes: actor.roleCodes,
        isFinalApprover: actor.isFinalApprover,
      }}
      unreadNotifications={unreadNotifications}
      groups={groups}
      grantedKeys={grantedKeys}
    >
      {children}
    </AppShell>
  );
}
