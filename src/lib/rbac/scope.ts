import { prisma } from '@/lib/db/prisma';
import type { Dimensions, ScopeDimension } from '@/lib/kernel/context';
import type { ModuleKey, PermissionAction } from '@/generated/prisma/client';

/**
 * Dimension scoping (PHASE_1_PLAN.md 5.3).
 *
 * Resolution order, and it matters:
 *
 *   1. Collect grants for the actor's live roles.
 *   2. Partition by dimension into ALLOW and DENY id sets.
 *   3. DENY always wins. There is no ordering in which an ALLOW beats a DENY.
 *   4. If a dimension has NO grants at all, it is unrestricted. This is how the
 *      CEO is unrestricted (Q7): the CEO role carries no narrowing grant, and
 *      absence of a restriction is the restriction.
 *   5. If a dimension HAS grants, the record's value must appear in ALLOW.
 *   6. A record that carries no value for a dimension is not constrained by it.
 *      A transaction with no project is not "outside every project".
 */

export interface ScopeGrant {
  dimension: ScopeDimension;
  dimensionValueId: string | null;
  includeChildren: boolean;
  effect: 'ALLOW' | 'DENY';
}

export interface ScopeDecision {
  allowed: boolean;
  /** Dimensions that actually blocked the decision, for the denial message. */
  blockedBy: ScopeDimension[];
  reason: 'ALLOWED' | 'NO_DIMENSION_VALUE' | 'UNRESTRICTED' | 'DENY_MATCH' | 'NOT_IN_ALLOW';
}

/**
 * Loads scope grants for a set of role ids.
 *
 * A grant with permissionId null applies to every action in the role; a grant
 * bound to a permission is loaded too and filtered by the caller when the
 * permissionId is known.
 */
export async function loadScopeGrants(roleIds: string[]): Promise<ScopeGrant[]> {
  if (roleIds.length === 0) return [];

  const rows = await prisma.roleScopeGrant.findMany({
    where: { roleId: { in: roleIds } },
    select: {
      dimension: true,
      dimensionValueId: true,
      includeChildren: true,
      effect: true,
    },
  });

  return rows.map((r) => ({
    dimension: r.dimension,
    dimensionValueId: r.dimensionValueId,
    includeChildren: r.includeChildren,
    effect: r.effect as 'ALLOW' | 'DENY',
  }));
}

export async function loadLiveRoleIds(userId: string): Promise<string[]> {
  const activeAt = new Date();
  const [userRoles, delegations] = await Promise.all([
    prisma.userRole.findMany({
      where: {
        userId,
        revokedAt: null,
        startsAt: { lte: activeAt },
        OR: [{ expiresAt: null }, { expiresAt: { gt: activeAt } }],
      },
      select: { roleId: true, role: { select: { isActive: true } } },
    }),
    prisma.delegation.findMany({
      where: {
        granteeId: userId,
        revokedAt: null,
        startsAt: { lte: activeAt },
        expiresAt: { gt: activeAt },
        role: { isActive: true },
      },
      select: { roleId: true },
    }),
  ]);

  return [
    ...new Set(
      [
        ...userRoles.filter((r) => r.role.isActive).map((r) => r.roleId),
        ...delegations.map((d) => d.roleId),
      ].filter((id): id is string => id !== null),
    ),
  ];
}

const DIMENSION_FIELD: Record<ScopeDimension, keyof Dimensions> = {
  PROJECT: 'projectId',
  DEPARTMENT: 'departmentId',
  COST_CENTRE: 'costCentreId',
  LOCATION: 'locationId',
  FUNDING_SOURCE: 'fundingSourceId',
  ACCOUNT: 'accountId',
};

export const ALL_SCOPE_DIMENSIONS = Object.keys(DIMENSION_FIELD) as ScopeDimension[];

export interface EvaluateScopeInput {
  grants: ScopeGrant[];
  dimensions: Dimensions;
  /**
   * Expands a dimension value to itself plus its descendants when a grant sets
   * includeChildren. Supplied by the caller because the Location/Department trees
   * arrive in M2; passing no resolver makes includeChildren behave as "exact
   * match only", which is the safe direction (it can narrow, never widen).
   */
  expandChildren?: (dimension: ScopeDimension, valueId: string) => Promise<string[]>;
}

/**
 * Pure scope decision. No I/O, so it is exhaustively unit-testable - which
 * matters, because a bug here silently shows a Finance Officer someone else's
 * records or, worse, hides their own.
 */
export async function evaluateScope(input: EvaluateScopeInput): Promise<ScopeDecision> {
  const { grants, dimensions } = input;
  const blockedBy: ScopeDimension[] = [];

  for (const dimension of ALL_SCOPE_DIMENSIONS) {
    const value = dimensions[DIMENSION_FIELD[dimension]];
    if (!value) continue;

    const dimensionGrants = grants.filter((g) => g.dimension === dimension);

    // No grants on this dimension means no restriction on this dimension.
    if (dimensionGrants.length === 0) continue;

    const allowedIds = new Set<string>();
    const deniedIds = new Set<string>();

    for (const grant of dimensionGrants) {
      // A null dimensionValueId on an ALLOW grant means "every value".
      if (grant.effect === 'DENY' && grant.dimensionValueId === null) {
        return { allowed: false, blockedBy: [dimension], reason: 'DENY_MATCH' };
      }

      const target = grant.effect === 'DENY' ? deniedIds : allowedIds;
      target.add(grant.dimensionValueId ?? '');

      if (grant.includeChildren && grant.dimensionValueId && input.expandChildren) {
        const children = await input.expandChildren(dimension, grant.dimensionValueId);
        for (const child of children) target.add(child);
      }
    }

    // DENY always wins.
    if (deniedIds.has(value)) {
      blockedBy.push(dimension);
      continue;
    }

    const anyValueAllowed = dimensionGrants.some(
      (g) => g.effect === 'ALLOW' && g.dimensionValueId === null,
    );
    if (!anyValueAllowed && !allowedIds.has(value)) {
      blockedBy.push(dimension);
      continue;
    }
  }

  if (blockedBy.length > 0) {
    return { allowed: false, blockedBy, reason: 'NOT_IN_ALLOW' };
  }

  return { allowed: true, blockedBy: [], reason: 'ALLOWED' };
}

/**
 * Builds a Prisma `where` fragment from a scope decision set, so list queries
 * cannot bypass the check that a single-record check would apply.
 *
 * A record with no value for a dimension is included: it is not scoped by that
 * dimension, which matches rule 6 above.
 */
export function applyScopeFilter(
  grants: ScopeGrant[],
  module: ModuleKey,
  action: PermissionAction,
  fieldPrefix = '',
): Record<string, unknown> {
  void module;
  void action;

  const and: Record<string, unknown>[] = [];

  for (const dimension of ALL_SCOPE_DIMENSIONS) {
    const dimensionGrants = grants.filter((g) => g.dimension === dimension);
    if (dimensionGrants.length === 0) continue;

    const field = `${fieldPrefix}${DIMENSION_FIELD[dimension]}`;
    const denied = dimensionGrants
      .filter((g) => g.effect === 'DENY' && g.dimensionValueId)
      .map((g) => g.dimensionValueId as string);
    const allowed = dimensionGrants
      .filter((g) => g.effect === 'ALLOW' && g.dimensionValueId)
      .map((g) => g.dimensionValueId as string);
    const allowAll = dimensionGrants.some(
      (g) => g.effect === 'ALLOW' && g.dimensionValueId === null,
    );

    if (allowAll) {
      if (denied.length > 0) {
        and.push({ OR: [{ [field]: null }, { [field]: { notIn: denied } }] });
      }
      continue;
    }

    and.push({
      OR: [{ [field]: null }, { [field]: { in: allowed } }],
    });
  }

  return and.length === 0 ? {} : { AND: and };
}
