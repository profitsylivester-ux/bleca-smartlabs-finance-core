import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db/prisma';
import { destroyUser } from '../setup/fixtures';
import { prismaForOrg } from '@/lib/db/tenant';
import { hashPassword } from '@/lib/auth/password';
import { attemptLogin, GENERIC_LOGIN_FAILURE } from '@/lib/auth/service';
import { clearRateLimits } from '@/lib/auth/rate-limit';
import { invalidateAuthPolicyCache } from '@/lib/auth/policy';
import { validateAndTouchSession, revokeSession } from '@/lib/auth/session';
import { KernelError } from '@/lib/kernel/errors';

/**
 * Authentication behaviour against a real database.
 *
 * The properties under test are the ones a login form cannot enforce on its own:
 * lockout, session timeouts, the MFA challenge state, and the fact that every
 * failure leaves a trace without leaving a state change.
 */

const meta = {
  ipAddress: '10.0.0.1',
  userAgent: 'integration-test-agent',
  deviceLabel: 'Integration test',
  requestId: `auth-${Date.now()}`,
};

async function createUser(suffix: string, roleCode: string, mfaEnforced: boolean) {
  const role = await prisma.role.findUniqueOrThrow({
    where: { code: roleCode },
    select: { id: true },
  });
  const org = await prisma.organization.findFirstOrThrow({
    where: { code: 'BLECA' },
    select: { id: true },
  });
  const id = `auth-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const password = 'IntegrationAuth#2026';

  const user = await prisma.user.create({
    data: {
      id,
      email: `${id}@test.local`,
      emailNormalized: `${id}@test.local`,
      fullName: `Auth ${suffix}`,
      status: 'ACTIVE',
      isActive: true,
      passwordHash: await hashPassword(password),
      passwordAlgorithm: 'ARGON2ID',
      mfaEnforced,
      organizationMemberships: { create: { organizationId: org.id, isDefault: true } },
      userRoles: { create: { roleId: role.id, reason: 'integration fixture' } },
    },
    select: { id: true, emailNormalized: true },
  });

  return { ...user, password };
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('password verification', () => {
  it('accepts the correct password and opens a session', async () => {
    clearRateLimits();
    // AUDITOR, because the AuthPolicy requires MFA for CEO and FINANCE_OFFICER.
    // A Finance Officer signing in with the right password correctly lands at the
    // MFA challenge instead, which is the next test.
    const user = await createUser('ok', 'AUDITOR', false);

    try {
      const result = await attemptLogin({
        email: user.emailNormalized,
        password: user.password,
        meta,
      });

      expect(result.status).toBe('SUCCESS');
      expect(result.userId).toBe(user.id);
      expect(result.mfaSatisfied).toBe(true);
      expect(result.sessionId).toBeTruthy();
    } finally {
      await destroyUser(prisma, user.id);
    }
  });

  it('rejects a wrong password with the generic message', async () => {
    clearRateLimits();
    const user = await createUser('wrong', 'AUDITOR', false);

    try {
      await expect(
        attemptLogin({ email: user.emailNormalized, password: 'WrongPassword#1', meta }),
      ).rejects.toThrow(GENERIC_LOGIN_FAILURE);
    } finally {
      await destroyUser(prisma, user.id);
    }
  });

  /**
   * Unknown address and wrong password must be indistinguishable, or the login
   * form becomes an account enumeration oracle.
   */
  it('returns the identical message for an unknown address', async () => {
    clearRateLimits();

    await expect(
      attemptLogin({ email: 'nobody@nowhere.local', password: 'SomePassword#1', meta }),
    ).rejects.toThrow(GENERIC_LOGIN_FAILURE);
  });

  it('records a LOGIN_FAILED audit entry for a failed attempt', async () => {
    clearRateLimits();
    const user = await createUser('auditfail', 'AUDITOR', false);

    try {
      await expect(
        attemptLogin({ email: user.emailNormalized, password: 'WrongPassword#1', meta }),
      ).rejects.toThrow();

      const entry = await prisma.loginHistory.findFirst({
        where: { userId: user.id, outcome: 'FAILURE_BAD_CREDENTIALS' },
        orderBy: { occurredAt: 'desc' },
        select: { outcome: true, failureReason: true },
      });

      expect(entry).not.toBeNull();
      expect(entry!.failureReason).toMatch(/consecutive failure 1/);
    } finally {
      await destroyUser(prisma, user.id);
    }
  });

  it('locks the account after the configured number of failures', async () => {
    clearRateLimits();
    invalidateAuthPolicyCache();
    const user = await createUser('lockout', 'AUDITOR', false);
    const policy = await prisma.authPolicy.findFirstOrThrow({ where: { isActive: true } });

    try {
      for (let attempt = 0; attempt < policy.maxFailedAttempts; attempt += 1) {
        await expect(
          attemptLogin({ email: user.emailNormalized, password: 'WrongPassword#1', meta }),
        ).rejects.toBeInstanceOf(KernelError);
      }

      const locked = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { lockedUntil: true, failedLoginCount: true },
      });
      expect(locked.lockedUntil).not.toBeNull();
      expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

      // Even the CORRECT password is refused while the lock stands.
      await expect(
        attemptLogin({ email: user.emailNormalized, password: user.password, meta }),
      ).rejects.toMatchObject({ code: 'ACCOUNT_LOCKED' });
    } finally {
      await destroyUser(prisma, user.id);
    }
  });

  it('refuses a deactivated account', async () => {
    clearRateLimits();
    const user = await createUser('deactivated', 'AUDITOR', false);

    try {
      await prisma.user.update({
        where: { id: user.id },
        data: { isActive: false, status: 'DEACTIVATED' },
      });

      await expect(
        attemptLogin({ email: user.emailNormalized, password: user.password, meta }),
      ).rejects.toThrow(GENERIC_LOGIN_FAILURE);
    } finally {
      await destroyUser(prisma, user.id);
    }
  });

  it('rate limits repeated attempts on one account', async () => {
    clearRateLimits();
    invalidateAuthPolicyCache();
    const policy = await prisma.authPolicy.findFirstOrThrow({ where: { isActive: true } });

    const email = 'ratelimit@nowhere.local';
    let limited = false;

    for (let i = 0; i < policy.maxAttemptsPerWindow + 3; i += 1) {
      try {
        await attemptLogin({ email, password: 'WrongPassword#1', meta });
      } catch (error) {
        if (error instanceof KernelError && error.code === 'RATE_LIMITED') {
          limited = true;
          break;
        }
      }
    }

    expect(limited).toBe(true);
  });
});

describe('MFA challenge state', () => {
  /**
   * BUILD_PROMPT 7: MFA is enforced for CEO and Finance Officer. The session is
   * created but left unsatisfied, so a correct password alone reaches nothing.
   */
  it('holds a CEO sign-in at the challenge when MFA is required', async () => {
    clearRateLimits();
    const user = await createUser('mfa', 'CEO', true);

    try {
      const result = await attemptLogin({
        email: user.emailNormalized,
        password: user.password,
        meta,
      });

      expect(result.status).toBe('MFA_REQUIRED');
      expect(result.mfaSatisfied).toBe(false);

      const validation = await validateAndTouchSession(result.sessionId);
      expect(validation.valid).toBe(true);
      expect(validation.mfaSatisfied).toBe(false);
    } finally {
      await destroyUser(prisma, user.id);
    }
  });

  it('reports the challenge as outstanding even when MFA is not yet enrolled', async () => {
    clearRateLimits();
    const user = await createUser('mfa-unenrolled', 'CEO', true);

    try {
      const result = await attemptLogin({
        email: user.emailNormalized,
        password: user.password,
        meta,
      });
      const validation = await validateAndTouchSession(result.sessionId);

      expect(validation.valid).toBe(true);
      expect(validation.mfaSatisfied).toBe(false);
      expect(await prisma.mfaDevice.count({ where: { userId: user.id, status: 'ACTIVE' } })).toBe(
        0,
      );
    } finally {
      await destroyUser(prisma, user.id);
    }
  });
});

describe('session lifecycle', () => {
  it('invalidates a revoked session on the next validation', async () => {
    clearRateLimits();
    const user = await createUser('revoke', 'AUDITOR', false);

    try {
      const result = await attemptLogin({
        email: user.emailNormalized,
        password: user.password,
        meta,
      });
      const session = await prisma.session.findUniqueOrThrow({
        where: { sessionToken: result.sessionId },
        select: { id: true },
      });

      expect((await validateAndTouchSession(result.sessionId)).valid).toBe(true);

      await revokeSession(session.id, 'ADMIN_REVOKED');

      const after = await validateAndTouchSession(result.sessionId);
      expect(after.valid).toBe(false);
      expect(after.reason).toBe('REVOKED');
    } finally {
      await destroyUser(prisma, user.id);
    }
  });

  it('expires an idle session', async () => {
    clearRateLimits();
    const user = await createUser('idle', 'AUDITOR', false);

    try {
      const result = await attemptLogin({
        email: user.emailNormalized,
        password: user.password,
        meta,
      });
      const session = await prisma.session.findUniqueOrThrow({
        where: { sessionToken: result.sessionId },
        select: { id: true },
      });

      await prisma.session.update({
        where: { id: session.id },
        data: { idleTimeoutAt: new Date(Date.now() - 1000) },
      });

      const after = await validateAndTouchSession(result.sessionId);
      expect(after.valid).toBe(false);
      expect(after.reason).toBe('IDLE_TIMEOUT');
    } finally {
      await destroyUser(prisma, user.id);
    }
  });

  it('expires an absolutely-timed-out session even if it was active a moment ago', async () => {
    clearRateLimits();
    const user = await createUser('absolute', 'AUDITOR', false);

    try {
      const result = await attemptLogin({
        email: user.emailNormalized,
        password: user.password,
        meta,
      });
      const session = await prisma.session.findUniqueOrThrow({
        where: { sessionToken: result.sessionId },
        select: { id: true },
      });

      await prisma.session.update({
        where: { id: session.id },
        data: {
          absoluteExpiresAt: new Date(Date.now() - 1000),
          idleTimeoutAt: new Date(Date.now() + 3600_000),
        },
      });

      const after = await validateAndTouchSession(result.sessionId);
      expect(after.valid).toBe(false);
      expect(after.reason).toBe('ABSOLUTE_TIMEOUT');
    } finally {
      await destroyUser(prisma, user.id);
    }
  });

  it('returns invalid for a token that does not exist', async () => {
    const validation = await validateAndTouchSession('no-such-token');
    expect(validation.valid).toBe(false);
    expect(validation.reason).toBe('NOT_FOUND');
  });

  it('refuses to delete a live session at the database level', async () => {
    clearRateLimits();
    const user = await createUser('delprotect', 'AUDITOR', false);

    try {
      const result = await attemptLogin({
        email: user.emailNormalized,
        password: user.password,
        meta,
      });

      await expect(
        prisma.$executeRawUnsafe(
          `DELETE FROM sessions WHERE session_token = '${result.sessionId}'`,
        ),
      ).rejects.toThrow(/live session/i);
    } finally {
      await destroyUser(prisma, user.id);
    }
  });
});

describe('tenant isolation', () => {
  it('confines reads to the scoped organisation', async () => {
    const scoped = prismaForOrg('org-does-not-exist');

    const entries = await scoped.auditLog.findMany();
    expect(entries).toEqual([]);
  });

  it('refuses a cross-tenant filter rather than silently overriding it', async () => {
    const scoped = prismaForOrg('org-a');

    await expect(
      scoped.auditLog.findMany({ where: { organizationId: 'org-b' } as never }),
    ).rejects.toThrow(/Cross-tenant query blocked/);
  });
});
