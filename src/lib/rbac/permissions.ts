import { prisma } from '@/lib/db/prisma';
import type { ModuleKey, PermissionAction } from '@/lib/kernel/context';

/**
 * Effective-permission resolution (PHASE_1_PLAN.md 5.3 step 1).
 *
 * Collects permissions from:
 *   - UserRole rows that are neither revoked nor expired
 *   - Delegation rows that grant a role to someone else, while unexpired
 *
 * Expiry is evaluated on every request, not only by the nightly cleanup job. A
 * grant that expired an hour ago is inert right now, whether or not the job has
 * run yet - otherwise revocation would lag reality by up to a day.
 */

export interface ResolvedPermission {
  module: ModuleKey;
  action: PermissionAction;
  resource: string | null;
  requiresStepUpAuth: boolean;
  /** Where the grant came from, for the audit trail and for support questions. */
  source: 'ROLE' | 'DELEGATION';
  viaRoleCode: string;
}

export interface EffectivePermissions {
  permissions: ResolvedPermission[];
  roleCodes: string[];
  isFinalApprover: boolean;
  hasRole: (code: string) => boolean;
}

const now = () => new Date();

export async function loadEffectivePermissions(userId: string): Promise<EffectivePermissions> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      status: true,
      isActive: true,
      deletedAt: true,
      userRoles: {
        where: { revokedAt: null },
        select: {
          startsAt: true,
          expiresAt: true,
          role: {
            select: {
              code: true,
              isActive: true,
              isFinalApprover: true,
              rolePermissions: {
                select: {
                  permission: {
                    select: {
                      module: true,
                      action: true,
                      resource: true,
                      requiresStepUpAuth: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!user || !user.isActive || user.deletedAt || user.status === 'DEACTIVATED') {
    return { permissions: [], roleCodes: [], isFinalApprover: false, hasRole: () => false };
  }

  const permissions: ResolvedPermission[] = [];
  const roleCodes: string[] = [];
  let isFinalApprover = false;

  const activeAt = now();

  const isLive = (startsAt: Date, expiresAt: Date | null) =>
    startsAt <= activeAt && (expiresAt === null || expiresAt > activeAt);

  for (const userRole of user.userRoles) {
    if (!isLive(userRole.startsAt, userRole.expiresAt)) continue;
    if (!userRole.role.isActive) continue;

    roleCodes.push(userRole.role.code);
    if (userRole.role.isFinalApprover) isFinalApprover = true;

    for (const rp of userRole.role.rolePermissions) {
      permissions.push({
        module: rp.permission.module,
        action: rp.permission.action,
        resource: rp.permission.resource,
        requiresStepUpAuth: rp.permission.requiresStepUpAuth,
        source: 'ROLE',
        viaRoleCode: userRole.role.code,
      });
    }
  }

  // Delegated authority. A delegation carries a role; while it is live the
  // grantee holds that role's permissions.
  const delegations = await prisma.delegation.findMany({
    where: {
      granteeId: userId,
      revokedAt: null,
      startsAt: { lte: activeAt },
      expiresAt: { gt: activeAt },
    },
    select: {
      role: {
        select: {
          code: true,
          isActive: true,
          isFinalApprover: true,
          rolePermissions: {
            select: {
              permission: {
                select: {
                  module: true,
                  action: true,
                  resource: true,
                  requiresStepUpAuth: true,
                },
              },
            },
          },
        },
      },
    },
  });

  for (const delegation of delegations) {
    if (!delegation.role?.isActive) continue;

    roleCodes.push(delegation.role.code);
    if (delegation.role.isFinalApprover) isFinalApprover = true;

    for (const rp of delegation.role.rolePermissions) {
      permissions.push({
        module: rp.permission.module,
        action: rp.permission.action,
        resource: rp.permission.resource,
        requiresStepUpAuth: rp.permission.requiresStepUpAuth,
        source: 'DELEGATION',
        viaRoleCode: delegation.role.code,
      });
    }
  }

  return {
    permissions,
    roleCodes: [...new Set(roleCodes)],
    isFinalApprover,
    hasRole: (code: string) => roleCodes.includes(code),
  };
}

export interface PermissionCheck {
  granted: boolean;
  requiresStepUpAuth: boolean;
  viaRoleCode: string | null;
  reason: 'GRANTED' | 'NO_MATCHING_PERMISSION' | 'PERMISSION_INACTIVE';
}

/**
 * A grant for (module, action, resource) matches when the stored resource is
 * either exactly the requested one, or null meaning "all resources in this
 * module+action".
 */
export function checkPermission(
  effective: EffectivePermissions,
  module: ModuleKey,
  action: PermissionAction,
  resource?: string,
): PermissionCheck {
  const wanted = resource ?? null;

  const candidates = effective.permissions.filter(
    (p) =>
      p.module === module && p.action === action && (p.resource === wanted || p.resource === null),
  );

  if (candidates.length === 0) {
    return {
      granted: false,
      requiresStepUpAuth: false,
      viaRoleCode: null,
      reason: 'NO_MATCHING_PERMISSION',
    };
  }

  // Exact resource match wins; otherwise a module-wide grant applies.
  const exact = candidates.find((p) => p.resource === wanted);
  const match = exact ?? candidates[0]!;

  return {
    granted: true,
    requiresStepUpAuth: match.requiresStepUpAuth,
    viaRoleCode: match.viaRoleCode,
    reason: 'GRANTED',
  };
}
