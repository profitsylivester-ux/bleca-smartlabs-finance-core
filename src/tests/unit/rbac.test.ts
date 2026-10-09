import { describe, expect, it } from 'vitest';
import { checkPermission, type EffectivePermissions } from '@/lib/rbac/permissions';
import { evaluateScope, applyScopeFilter, type ScopeGrant } from '@/lib/rbac/scope';
import { EMPTY_DIMENSIONS, dimensionsOf } from '@/lib/kernel/context';

function effective(
  permissions: Array<{
    module: EffectivePermissions['permissions'][number]['module'];
    action: EffectivePermissions['permissions'][number]['action'];
    resource?: string | null;
  }>,
): EffectivePermissions {
  return {
    permissions: permissions.map((p) => ({
      module: p.module,
      action: p.action,
      resource: p.resource ?? null,
      requiresStepUpAuth: false,
      source: 'ROLE' as const,
      viaRoleCode: 'TEST',
    })),
    roleCodes: ['TEST'],
    isFinalApprover: false,
    hasRole: () => true,
  };
}

describe('checkPermission', () => {
  it('grants an exact (module, action) match', () => {
    const result = checkPermission(
      effective([{ module: 'TRANSACTIONS', action: 'POST' }]),
      'TRANSACTIONS',
      'POST',
    );
    expect(result.granted).toBe(true);
  });

  it('denies when the action is not granted', () => {
    const result = checkPermission(
      effective([{ module: 'TRANSACTIONS', action: 'VIEW' }]),
      'TRANSACTIONS',
      'POST',
    );
    expect(result.granted).toBe(false);
    expect(result.reason).toBe('NO_MATCHING_PERMISSION');
  });

  /**
   * A module-wide grant (resource = null) covers every sub-resource. This is how
   * "(SUPPLIERS, EDIT)" comes to imply "(SUPPLIERS, EDIT, supplier.bank_details)"
   * for a role that was granted the general permission - and why the step-up
   * protected resource still has its own separate row to grant deliberately.
   */
  it('a null-resource grant covers a specific sub-resource', () => {
    const result = checkPermission(
      effective([{ module: 'SUPPLIERS', action: 'EDIT', resource: null }]),
      'SUPPLIERS',
      'EDIT',
      'supplier.bank_details',
    );
    expect(result.granted).toBe(true);
  });

  it('a resource-specific grant does not cover a different sub-resource', () => {
    const result = checkPermission(
      effective([{ module: 'SUPPLIERS', action: 'EDIT', resource: 'supplier.contact' }]),
      'SUPPLIERS',
      'EDIT',
      'supplier.bank_details',
    );
    expect(result.granted).toBe(false);
  });

  it('prefers an exact resource match when both exist', () => {
    const result = checkPermission(
      effective([
        { module: 'SUPPLIERS', action: 'EDIT', resource: null },
        { module: 'SUPPLIERS', action: 'EDIT', resource: 'supplier.bank_details' },
      ]),
      'SUPPLIERS',
      'EDIT',
      'supplier.bank_details',
    );
    expect(result.granted).toBe(true);
    expect(result.viaRoleCode).toBe('TEST');
  });
});

describe('evaluateScope', () => {
  const mbeya = 'loc-mbeya';
  const dar = 'loc-dar';

  const financeOfficerGrants: ScopeGrant[] = [
    { dimension: 'LOCATION', dimensionValueId: mbeya, includeChildren: true, effect: 'ALLOW' },
  ];

  it('allows a record inside the granted scope', async () => {
    const decision = await evaluateScope({
      grants: financeOfficerGrants,
      dimensions: dimensionsOf({ locationId: mbeya }),
    });
    expect(decision.allowed).toBe(true);
  });

  it('blocks a record outside the granted scope', async () => {
    const decision = await evaluateScope({
      grants: financeOfficerGrants,
      dimensions: dimensionsOf({ locationId: dar }),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('NOT_IN_ALLOW');
    expect(decision.blockedBy).toContain('LOCATION');
  });

  /**
   * Q7: the CEO is unrestricted. That is expressed as the ABSENCE of a narrowing
   * grant, not as a wildcard grant - so the same resolution code serves both
   * roles and there is no special case to get wrong.
   */
  it('treats a dimension with no grants as unrestricted', async () => {
    const decision = await evaluateScope({
      grants: [],
      dimensions: dimensionsOf({ locationId: dar, projectId: 'p-any' }),
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('ALLOWED');
  });

  /**
   * A record with no value for a dimension is not scoped by it. Treating "no
   * project" as "outside every project" would hide every unprojected transaction
   * from a scoped Finance Officer.
   */
  it('does not constrain a dimension the record does not carry', async () => {
    const decision = await evaluateScope({
      grants: financeOfficerGrants,
      dimensions: dimensionsOf({ projectId: 'p-1' }),
    });
    expect(decision.allowed).toBe(true);
  });

  it('DENY always wins over ALLOW, in every combination', async () => {
    const grants: ScopeGrant[] = [
      { dimension: 'LOCATION', dimensionValueId: mbeya, includeChildren: true, effect: 'ALLOW' },
      { dimension: 'LOCATION', dimensionValueId: mbeya, includeChildren: true, effect: 'DENY' },
    ];

    const decision = await evaluateScope({
      grants,
      dimensions: dimensionsOf({ locationId: mbeya }),
    });
    expect(decision.allowed).toBe(false);
  });

  it('a null DENY on a dimension blocks everything in it', async () => {
    const grants: ScopeGrant[] = [
      { dimension: 'LOCATION', dimensionValueId: mbeya, includeChildren: false, effect: 'ALLOW' },
      { dimension: 'LOCATION', dimensionValueId: null, includeChildren: false, effect: 'DENY' },
    ];

    const decision = await evaluateScope({
      grants,
      dimensions: dimensionsOf({ locationId: mbeya }),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('DENY_MATCH');
  });

  it('an ALLOW with a null value permits every value in that dimension', async () => {
    const grants: ScopeGrant[] = [
      { dimension: 'DEPARTMENT', dimensionValueId: null, includeChildren: false, effect: 'ALLOW' },
    ];

    const decision = await evaluateScope({
      grants,
      dimensions: dimensionsOf({ departmentId: 'anything-at-all' }),
    });
    expect(decision.allowed).toBe(true);
  });

  it('expands includeChildren through the injected resolver', async () => {
    const grants: ScopeGrant[] = [
      { dimension: 'LOCATION', dimensionValueId: mbeya, includeChildren: true, effect: 'ALLOW' },
    ];

    const decision = await evaluateScope({
      grants,
      dimensions: dimensionsOf({ locationId: 'loc-mbeya-campus' }),
      expandChildren: async (_dimension, valueId) =>
        valueId === mbeya ? [mbeya, 'loc-mbeya-campus'] : [],
    });

    expect(decision.allowed).toBe(true);
  });

  /**
   * Without a resolver, includeChildren behaves as an exact match. Narrowing is
   * the safe direction: it can hide a record the user should not see, but it can
   * never show one they should not.
   */
  it('treats includeChildren as exact when no resolver is supplied', async () => {
    const grants: ScopeGrant[] = [
      { dimension: 'LOCATION', dimensionValueId: mbeya, includeChildren: true, effect: 'ALLOW' },
    ];

    const decision = await evaluateScope({
      grants,
      dimensions: dimensionsOf({ locationId: 'loc-mbeya-campus' }),
    });

    expect(decision.allowed).toBe(false);
  });

  it('blocks when any one of several dimensions fails', async () => {
    const grants: ScopeGrant[] = [
      { dimension: 'LOCATION', dimensionValueId: mbeya, includeChildren: false, effect: 'ALLOW' },
      {
        dimension: 'PROJECT',
        dimensionValueId: 'project-iventika',
        includeChildren: false,
        effect: 'ALLOW',
      },
    ];

    const decision = await evaluateScope({
      grants,
      dimensions: dimensionsOf({ locationId: mbeya, projectId: 'project-uzanite' }),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.blockedBy).toEqual(['PROJECT']);
  });

  it('allows a record carrying no dimensions at all', async () => {
    const decision = await evaluateScope({
      grants: financeOfficerGrants,
      dimensions: EMPTY_DIMENSIONS,
    });
    expect(decision.allowed).toBe(true);
  });
});

describe('applyScopeFilter', () => {
  it('produces no filter when nothing is scoped', () => {
    expect(applyScopeFilter([], 'TRANSACTIONS', 'VIEW')).toEqual({});
  });

  it('includes records that carry no value for a scoped dimension', () => {
    const grants: ScopeGrant[] = [
      {
        dimension: 'LOCATION',
        dimensionValueId: 'loc-mbeya',
        includeChildren: false,
        effect: 'ALLOW',
      },
    ];

    const filter = applyScopeFilter(grants, 'TRANSACTIONS', 'VIEW');

    expect(filter).toEqual({
      AND: [{ OR: [{ locationId: null }, { locationId: { in: ['loc-mbeya'] } }] }],
    });
  });

  it('excludes denied values even when the dimension is otherwise open', () => {
    const grants: ScopeGrant[] = [
      { dimension: 'LOCATION', dimensionValueId: null, includeChildren: false, effect: 'ALLOW' },
      {
        dimension: 'LOCATION',
        dimensionValueId: 'loc-secret',
        includeChildren: false,
        effect: 'DENY',
      },
    ];

    const filter = applyScopeFilter(grants, 'TRANSACTIONS', 'VIEW');

    expect(filter).toEqual({
      AND: [{ OR: [{ locationId: null }, { locationId: { notIn: ['loc-secret'] } }] }],
    });
  });

  it('honours a field prefix for related models', () => {
    const grants: ScopeGrant[] = [
      { dimension: 'PROJECT', dimensionValueId: 'p1', includeChildren: false, effect: 'ALLOW' },
    ];

    const filter = applyScopeFilter(grants, 'TRANSACTIONS', 'VIEW', 'journalLines.');

    expect(JSON.stringify(filter)).toContain('journalLines.projectId');
  });
});
