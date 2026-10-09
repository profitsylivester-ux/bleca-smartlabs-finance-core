import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db/prisma';
import { destroyUser } from '../setup/fixtures';
import { authorize } from '@/lib/kernel/authorize';
import { loadEffectivePermissions } from '@/lib/rbac/permissions';
import { AuthorizationError, StepUpAuthRequired } from '@/lib/kernel/errors';
import { dimensionsOf } from '@/lib/kernel/context';
import type { RequestContext } from '@/lib/kernel/context';
import { hashPassword } from '@/lib/auth/password';
import { invalidateAuthPolicyCache } from '@/lib/auth/policy';

/**
 * The negative path for authorization (PHASE_1_PLAN.md 5.4).
 *
 * The rule being tested: a caller who skips the UI and calls the endpoint
 * directly gets 403 AND leaves an ACCESS_DENIED audit entry. A permission check
 * that only exists in the interface is a suggestion, not a control.
 *
 * These tests call authorize() the way a service function does - as the first
 * statement, with a RequestContext - rather than going through HTTP, because the
 * guarantee being tested is the kernel's, and the transport layer's job is
 * only to translate the thrown error into a status code.
 */

let ceoId: string;
let auditorId: string;
let organizationId: string;

function contextFor(userId: string, roleCodes: string[]): RequestContext {
  return {
    actor: {
      userId,
      email: `${userId}@test.local`,
      fullName: 'Test Actor',
      roleCodes,
      isFinalApprover: roleCodes.includes('CEO'),
      organizationId,
      sessionId: null,
      mfaSatisfiedAt: new Date(),
      stepUpSatisfiedAt: null,
      stepUpExpiresAt: null,
    },
    requestId: `test-${userId}-${Math.random().toString(36).slice(2)}`,
    channel: 'API',
    idempotencyKey: null,
    ipAddress: '127.0.0.1',
    userAgent: 'integration-test',
    syncBatchId: null,
  };
}

beforeAll(async () => {
  invalidateAuthPolicyCache();

  const org = await prisma.organization.findFirstOrThrow({
    where: { code: 'BLECA' },
    select: { id: true },
  });
  organizationId = org.id;

  const password = await hashPassword('IntegrationTest#2026');

  const ceoRole = await prisma.role.findUniqueOrThrow({
    where: { code: 'CEO' },
    select: { id: true },
  });
  const auditorRole = await prisma.role.findUniqueOrThrow({
    where: { code: 'AUDITOR' },
    select: { id: true },
  });

  ceoId = `test-ceo-${Date.now()}`;
  auditorId = `test-auditor-${Date.now()}`;

  await prisma.user.create({
    data: {
      id: ceoId,
      email: `${ceoId}@test.local`,
      emailNormalized: `${ceoId}@test.local`,
      fullName: 'Test CEO',
      status: 'ACTIVE',
      isActive: true,
      passwordHash: password,
      passwordAlgorithm: 'ARGON2ID',
      userRoles: { create: { roleId: ceoRole.id, reason: 'integration fixture' } },
      organizationMemberships: { create: { organizationId, isDefault: true } },
    },
  });

  await prisma.user.create({
    data: {
      id: auditorId,
      email: `${auditorId}@test.local`,
      emailNormalized: `${auditorId}@test.local`,
      fullName: 'Test Auditor',
      status: 'ACTIVE',
      isActive: true,
      passwordHash: password,
      passwordAlgorithm: 'ARGON2ID',
      userRoles: { create: { roleId: auditorRole.id, reason: 'integration fixture' } },
      organizationMemberships: { create: { organizationId, isDefault: true } },
    },
  });
});

afterAll(async () => {
  await destroyUser(prisma, ceoId);
  await destroyUser(prisma, auditorId);
  await prisma.$disconnect();
});

describe('permission matrix', () => {
  it('grants the CEO the approve permission on financial modules (Q2: every amount)', async () => {
    const effective = await loadEffectivePermissions(ceoId);
    const modules = effective.permissions
      .filter((p) => p.action === 'APPROVE')
      .map((p) => p.module);

    expect(modules).toContain('TRANSACTIONS');
    expect(modules).toContain('INVOICES');
    expect(modules).toContain('PAYMENTS');
    expect(modules).toContain('BUDGETS');
  });

  /**
   * PDF 3.2: the Finance Officer cannot approve their own submissions. The seed
   * gives the role no APPROVE permission at all, so this is enforced by absence
   * rather than by a rule that could be mis-evaluated.
   */
  it('gives the Auditor no write permission anywhere', async () => {
    const effective = await loadEffectivePermissions(auditorId);

    const writes = effective.permissions.filter((p) => !['VIEW', 'EXPORT'].includes(p.action));
    expect(writes).toEqual([]);
  });

  it('reports no permissions for an unknown user rather than throwing', async () => {
    const effective = await loadEffectivePermissions('does-not-exist');
    expect(effective.permissions).toEqual([]);
    expect(effective.isFinalApprover).toBe(false);
  });
});

describe('authorize: the direct-call negative path', () => {
  it('throws when the caller lacks the permission', async () => {
    const ctx = contextFor(auditorId, ['AUDITOR']);

    await expect(
      authorize(ctx, { module: 'USERS_ROLES', action: 'CREATE' }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('writes an ACCESS_DENIED audit entry for the refused attempt', async () => {
    const ctx = contextFor(auditorId, ['AUDITOR']);

    await expect(
      authorize(ctx, {
        module: 'USERS_ROLES',
        action: 'ADMINISTER',
        entity: { type: 'USER', id: 'someone-else' },
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);

    const entry = await prisma.auditLog.findFirst({
      where: { requestId: ctx.requestId },
      orderBy: { sequence: 'desc' },
      select: { action: true, result: true, actorId: true, entityId: true, description: true },
    });

    expect(entry).not.toBeNull();
    expect(entry!.action).toBe('ACCESS_DENIED');
    expect(entry!.result).toBe('DENIED');
    expect(entry!.actorId).toBe(auditorId);
    expect(entry!.entityId).toBe('someone-else');
  });

  it('raises a matching SecurityEvent alongside the denial', async () => {
    const ctx = contextFor(auditorId, ['AUDITOR']);

    await expect(
      authorize(ctx, { module: 'PERIODS', action: 'ADMINISTER' }),
    ).rejects.toBeInstanceOf(AuthorizationError);

    const event = await prisma.securityEvent.findFirst({
      where: { auditLog: { requestId: ctx.requestId } },
      select: { type: true, severity: true, acknowledgedAt: true },
    });

    expect(event?.type).toBe('PERMISSION_DENIED_SPIKE');
    expect(event?.severity).toBe('MEDIUM');
    expect(event?.acknowledgedAt).toBeNull();
  });

  /**
   * PDF 49: export authorisation is separate from view authorisation. Being able
   * to read the audit trail does not imply being able to administer it or take a
   * modified copy of it. The Auditor role is read-only, so ADMINISTER is denied
   * even though VIEW is granted.
   */
  it('does not let VIEW imply ADMINISTER', async () => {
    const ctx = contextFor(auditorId, ['AUDITOR']);

    await expect(authorize(ctx, { module: 'AUDIT_TRAIL', action: 'VIEW' })).resolves.toBeDefined();

    await expect(
      authorize(ctx, { module: 'AUDIT_TRAIL', action: 'ADMINISTER' }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('allows the CEO to do what the CEO is meant to do', async () => {
    const ctx = contextFor(ceoId, ['CEO']);

    await expect(
      authorize(ctx, { module: 'AUDIT_TRAIL', action: 'ADMINISTER' }),
    ).resolves.toBeDefined();
  });
});

describe('authorize: scope enforcement (Q7)', () => {
  it('blocks a scoped role from a record outside its dimensions', async () => {
    const auditorRole = await prisma.role.findUniqueOrThrow({
      where: { code: 'AUDITOR' },
      select: { id: true },
    });

    await prisma.roleScopeGrant.create({
      data: {
        roleId: auditorRole.id,
        dimension: 'LOCATION',
        dimensionValueId: 'loc-mbeya',
        includeChildren: true,
        effect: 'ALLOW',
      },
    });

    const ctx = contextFor(auditorId, ['AUDITOR']);

    try {
      await expect(
        authorize(ctx, {
          module: 'REPORTS',
          action: 'VIEW',
          entity: { type: 'USER', dimensions: dimensionsOf({ locationId: 'loc-dar-es-salaam' }) },
        }),
      ).rejects.toMatchObject({ code: 'SCOPE_VIOLATION' });
    } finally {
      await prisma.roleScopeGrant.deleteMany({
        where: { roleId: auditorRole.id, dimensionValueId: 'loc-mbeya' },
      });
    }
  });

  it('allows a record inside the granted dimensions', async () => {
    const ctx = contextFor(auditorId, ['AUDITOR']);

    await expect(
      authorize(ctx, {
        module: 'REPORTS',
        action: 'VIEW',
        entity: { type: 'USER', dimensions: dimensionsOf({ locationId: 'loc-mbeya' }) },
      }),
    ).resolves.toBeDefined();
  });

  /**
   * Q7: the CEO is unrestricted because no narrowing grant exists for the role,
   * not because the CEO role carries a wildcard. Same resolution code, no special
   * case to get wrong.
   */
  it('leaves the CEO unrestricted', async () => {
    const ctx = contextFor(ceoId, ['CEO']);

    await expect(
      authorize(ctx, {
        module: 'REPORTS',
        action: 'VIEW',
        entity: { type: 'USER', dimensions: dimensionsOf({ locationId: 'loc-anywhere-at-all' }) },
      }),
    ).resolves.toBeDefined();
  });

  it('does not apply scope when the entity carries no dimensions', async () => {
    const ctx = contextFor(auditorId, ['AUDITOR']);

    await expect(
      authorize(ctx, { module: 'REPORTS', action: 'VIEW', entity: { type: 'SYSTEM' } }),
    ).resolves.toBeDefined();
  });
});

describe('authorize: step-up authentication', () => {
  it('requires re-authentication for a step-up protected permission', async () => {
    const ctx = contextFor(ceoId, ['CEO']);

    await expect(
      authorize(ctx, {
        module: 'USERS_ROLES',
        action: 'ADMINISTER',
        entity: { type: 'USER', id: 'target' },
      }),
    ).rejects.toBeInstanceOf(StepUpAuthRequired);
  });

  it('allows the action once a fresh step-up grant exists', async () => {
    const ctx = contextFor(ceoId, ['CEO']);
    ctx.actor.stepUpSatisfiedAt = new Date();
    ctx.actor.stepUpExpiresAt = new Date(Date.now() + 5 * 60_000);

    await expect(
      authorize(ctx, {
        module: 'USERS_ROLES',
        action: 'ADMINISTER',
        entity: { type: 'USER', id: 'target' },
      }),
    ).resolves.toBeDefined();
  });

  it('refuses once the step-up grant has expired', async () => {
    const ctx = contextFor(ceoId, ['CEO']);
    ctx.actor.stepUpSatisfiedAt = new Date(Date.now() - 10 * 60_000);
    ctx.actor.stepUpExpiresAt = new Date(Date.now() - 5 * 60_000);

    await expect(
      authorize(ctx, {
        module: 'USERS_ROLES',
        action: 'ADMINISTER',
        entity: { type: 'USER', id: 'target' },
      }),
    ).rejects.toBeInstanceOf(StepUpAuthRequired);
  });
});

describe('temporary access and delegation expiry', () => {
  it('renders an expired role grant inert', async () => {
    const userId = `test-temp-${Date.now()}`;
    const auditorRole = await prisma.role.findUniqueOrThrow({
      where: { code: 'AUDITOR' },
      select: { id: true },
    });

    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@test.local`,
        emailNormalized: `${userId}@test.local`,
        fullName: 'Expired Grant User',
        status: 'ACTIVE',
        isActive: true,
        userRoles: {
          create: {
            roleId: auditorRole.id,
            isTemporary: true,
            startsAt: new Date(Date.now() - 48 * 3600_000),
            expiresAt: new Date(Date.now() - 3600_000),
            reason: 'integration fixture: already expired',
          },
        },
      },
    });

    try {
      const effective = await loadEffectivePermissions(userId);
      expect(effective.permissions).toEqual([]);
      expect(effective.roleCodes).not.toContain('AUDITOR');

      await expect(
        authorize(contextFor(userId, ['AUDITOR']), { module: 'AUDIT_TRAIL', action: 'VIEW' }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    } finally {
      await destroyUser(prisma, userId);
    }
  });

  it('honours a live delegation', async () => {
    const userId = `test-delegate-${Date.now()}`;
    const ceoRole = await prisma.role.findUniqueOrThrow({
      where: { code: 'CEO' },
      select: { id: true },
    });

    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@test.local`,
        emailNormalized: `${userId}@test.local`,
        fullName: 'Delegate User',
        status: 'ACTIVE',
        isActive: true,
      },
    });

    await prisma.delegation.create({
      data: {
        grantorId: ceoId,
        granteeId: userId,
        kind: 'APPROVAL_AUTHORITY',
        roleId: ceoRole.id,
        reason: 'integration fixture: delegation',
        startsAt: new Date(Date.now() - 3600_000),
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });

    try {
      const effective = await loadEffectivePermissions(userId);
      expect(effective.roleCodes).toContain('CEO');
      expect(effective.permissions.some((p) => p.source === 'DELEGATION')).toBe(true);

      await expect(
        authorize(contextFor(userId, ['CEO']), { module: 'TRANSACTIONS', action: 'APPROVE' }),
      ).resolves.toBeDefined();
    } finally {
      await destroyUser(prisma, userId);
    }
  });

  it('treats an expired delegation as absent without waiting for a cleanup job', async () => {
    const userId = `test-expired-delegate-${Date.now()}`;
    const ceoRole = await prisma.role.findUniqueOrThrow({
      where: { code: 'CEO' },
      select: { id: true },
    });

    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@test.local`,
        emailNormalized: `${userId}@test.local`,
        fullName: 'Expired Delegate',
        status: 'ACTIVE',
        isActive: true,
      },
    });

    await prisma.delegation.create({
      data: {
        grantorId: ceoId,
        granteeId: userId,
        kind: 'APPROVAL_AUTHORITY',
        roleId: ceoRole.id,
        reason: 'integration fixture: expired delegation',
        startsAt: new Date(Date.now() - 48 * 3600_000),
        expiresAt: new Date(Date.now() - 3600_000),
      },
    });

    try {
      const effective = await loadEffectivePermissions(userId);
      expect(effective.roleCodes).toEqual([]);
      expect(effective.isFinalApprover).toBe(false);
    } finally {
      await destroyUser(prisma, userId);
    }
  });
});
