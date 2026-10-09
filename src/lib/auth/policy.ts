import { prisma } from '@/lib/db/prisma';
import type { AuthPolicy } from '@/generated/prisma/client';

/**
 * Auth policy loader.
 *
 * Every threshold that governs authentication - lockout, rate limiting, password
 * rules, session timeouts, which roles require MFA - lives in this table, not in
 * code (PDF 4). Changing one is an audited CONFIGURATION_CHANGES event, not a
 * deploy, and it can be reverted.
 *
 * Cached for a short window because it is read on every request. The cache is
 * deliberately short: an emergency "revoke all sessions by tightening the
 * absolute timeout" should take effect in seconds, not after a deploy.
 */

const CACHE_TTL_MS = 15_000;
let cached: { policy: AuthPolicy; loadedAt: number } | null = null;

export const DEFAULT_POLICY_NAME = 'DEFAULT';

export async function loadAuthPolicy(force = false): Promise<AuthPolicy> {
  if (!force && cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return cached.policy;
  }

  const policy =
    (await prisma.authPolicy.findFirst({
      where: { isActive: true },
      orderBy: { priority: 'asc' },
    })) ?? (await prisma.authPolicy.findUnique({ where: { name: DEFAULT_POLICY_NAME } }));

  if (!policy) {
    throw new Error(
      'No AuthPolicy row exists. Authentication cannot proceed. Run `npm run db:seed`.',
    );
  }

  cached = { policy, loadedAt: Date.now() };
  return policy;
}

export function invalidateAuthPolicyCache(): void {
  cached = null;
}

/**
 * MFA is required for a user when EITHER the user record says so, OR the active
 * policy names one of their roles.
 *
 * Both paths exist on purpose: the policy lets an operator add a role to the
 * MFA requirement without touching user rows, and the per-user flag lets an
 * administrator require MFA for one specific person without a policy change.
 * Either one alone would create a gap.
 */
export function mfaRequiredFor(
  policy: AuthPolicy,
  roleCodes: string[],
  userMfaEnforced: boolean,
): boolean {
  if (userMfaEnforced) return true;
  return roleCodes.some((code) => policy.mfaRequiredRoleCodes.includes(code));
}

export function roleRequiresMfa(policy: AuthPolicy, roleCodes: string[]): boolean {
  return roleCodes.some((code) => policy.mfaRequiredRoleCodes.includes(code));
}
