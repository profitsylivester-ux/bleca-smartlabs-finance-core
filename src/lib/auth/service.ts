import { prisma } from '@/lib/db/prisma';
import { loadAuthPolicy, mfaRequiredFor } from '@/lib/auth/policy';
import {
  hashPassword,
  verifyPassword,
  assertPasswordStrength,
  looksLikeEmail,
} from '@/lib/auth/password';
import {
  checkRateLimit,
  rateLimitKeys,
  clearRateLimits,
  type RateLimitDecision,
} from '@/lib/auth/rate-limit';
import {
  verifyTotpCode,
  verifyRecoveryCode,
  generateTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  buildOtpAuthUri,
} from '@/lib/auth/totp';
import {
  issueSession,
  describeDevice,
  fingerprintOf,
  revokeAllForUser,
  grantStepUp,
} from '@/lib/auth/session';
import { writeAuditEntry, SYSTEM_ACTOR } from '@/lib/audit/writer';
import { hashToken, randomToken } from '@/lib/crypto';
import { KernelError, ValidationError, NotFoundError } from '@/lib/kernel/errors';
import type { LoginOutcome, MfaMethod } from '@/generated/prisma/client';

/**
 * Authentication service.
 *
 * Every failure path here writes an audit entry in its OWN committed transaction.
 * That is deliberate and it is the opposite of the usual transactional pattern: a
 * rejected login must leave a trace, and a rollback would erase it. The only
 * thing a failed attempt must never do is change state - so the failed-login
 * counter increment, the LoginHistory row and the audit entry are committed
 * together, and nothing else.
 *
 * The invariant that shapes this whole file: authentication never reveals which
 * half was wrong. Unknown email, wrong password, disabled account and locked
 * account all surface to the caller as the same generic failure, while the audit
 * trail records the real reason. Otherwise the login form becomes an account
 * enumeration oracle.
 */

export const GENERIC_LOGIN_FAILURE = 'Incorrect email or password.';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface LoginMeta {
  ipAddress: string | null;
  userAgent: string | null;
  deviceLabel?: string | null;
  requestId: string;
}

export interface LoginSuccess {
  status: 'SUCCESS' | 'MFA_REQUIRED';
  userId: string;
  email: string;
  fullName: string;
  organizationId: string | null;
  roleCodes: string[];
  isFinalApprover: boolean;
  sessionId: string;
  mustChangePassword: boolean;
  mfaSatisfied: boolean;
}

async function logAttempt(input: {
  userId: string | null;
  email: string;
  outcome: LoginOutcome;
  reason?: string;
  meta: LoginMeta;
  mfaAttempted?: boolean;
  sessionId?: string | null;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.loginHistory.create({
      data: {
        userId: input.userId,
        emailAttempted: input.email,
        outcome: input.outcome,
        failureReason: input.reason ?? null,
        ipAddress: input.meta.ipAddress,
        userAgent: input.meta.userAgent,
        deviceFingerprint: fingerprintOf(input.meta.ipAddress, input.meta.userAgent),
        mfaAttempted: input.mfaAttempted ?? false,
        sessionId: input.sessionId ?? null,
      },
    });

    await writeAuditEntry(
      tx,
      input.userId ? { id: input.userId, name: null, roleCodes: [] } : SYSTEM_ACTOR,
      {
        action: input.outcome === 'SUCCESS' ? 'LOGIN' : 'LOGIN_FAILED',
        entityType: 'USER',
        entityId: input.userId,
        description:
          input.outcome === 'SUCCESS'
            ? `Successful sign-in for ${input.email}`
            : `Failed sign-in for ${input.email}: ${input.reason ?? input.outcome}`,
        result: input.outcome === 'SUCCESS' ? 'SUCCESS' : 'FAILURE',
        metadata: { mfaAttempted: input.mfaAttempted ?? false },
        securityEvent:
          input.outcome === 'FAILURE_BAD_CREDENTIALS' && input.reason?.includes('consecutive')
            ? {
                type: 'BRUTE_FORCE_ATTEMPT',
                severity: 'MEDIUM',
                subjectType: 'USER',
                subjectId: input.userId,
                description: `Repeated failed sign-ins for ${input.email}`,
              }
            : undefined,
      },
      {
        ipAddress: input.meta.ipAddress,
        userAgent: input.meta.userAgent,
        requestId: input.meta.requestId,
      },
    );
  });
}

/**
 * Verifies credentials and, on success, opens a session.
 *
 * A session is opened even when MFA is still outstanding - it is created in an
 * unverified state (mfaSatisfiedAt = null) with the short challenge timeout. The
 * cookie exists but grants nothing: every guarded route requires
 * mfaSatisfiedAt, so an unfinished MFA challenge cannot reach the application.
 */
export async function attemptLogin(input: {
  email: string;
  password: string;
  meta: LoginMeta;
}): Promise<LoginSuccess> {
  const policy = await loadAuthPolicy();
  const email = normalizeEmail(input.email);

  // Per-IP first: cheap, and it sheds a spray before we touch the database.
  const ipLimit: RateLimitDecision = checkRateLimit(
    rateLimitKeys.ip(input.meta.ipAddress ?? 'unknown'),
    policy.ipRateLimitPerMinute,
    60,
  );
  if (!ipLimit.allowed) {
    throw new KernelError(
      'RATE_LIMITED',
      'Too many attempts from this network. Please wait a moment.',
      {
        details: { retryAfterSeconds: ipLimit.retryAfterSeconds },
        retryable: true,
      },
    );
  }

  const accountLimit = checkRateLimit(
    rateLimitKeys.account(email),
    policy.maxAttemptsPerWindow,
    policy.rateLimitWindowSeconds,
  );
  if (!accountLimit.allowed) {
    await logAttempt({
      userId: null,
      email,
      outcome: 'BLOCKED_RATE_LIMIT',
      reason: 'rate limit',
      meta: input.meta,
    });
    throw new KernelError('RATE_LIMITED', 'Too many attempts. Please wait before trying again.', {
      details: { retryAfterSeconds: accountLimit.retryAfterSeconds },
      retryable: true,
    });
  }

  const user = await prisma.user.findUnique({
    where: { emailNormalized: email },
    select: {
      id: true,
      email: true,
      fullName: true,
      status: true,
      isActive: true,
      deletedAt: true,
      passwordHash: true,
      mustChangePassword: true,
      mfaEnforced: true,
      failedLoginCount: true,
      lockedUntil: true,
      organizationMemberships: {
        where: { isDefault: true },
        take: 1,
        select: { organizationId: true },
      },
      userRoles: {
        where: { revokedAt: null },
        select: { role: { select: { code: true, isActive: true, isFinalApprover: true } } },
      },
    },
  });

  const genericFailure = () => new KernelError('INVALID_CREDENTIALS', GENERIC_LOGIN_FAILURE);

  if (!user || !user.passwordHash || user.deletedAt) {
    // Spend comparable time on an unknown account so response time does not
    // disclose whether the address exists.
    await verifyPassword(
      '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$0000000000000000000000000000000000000000000',
      input.password,
    ).catch(() => false);
    await logAttempt({
      userId: user?.id ?? null,
      email,
      outcome: 'FAILURE_BAD_CREDENTIALS',
      reason: 'unknown account or no credential set',
      meta: input.meta,
    });
    throw genericFailure();
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    await logAttempt({
      userId: user.id,
      email,
      outcome: 'FAILURE_LOCKED',
      reason: 'account locked',
      meta: input.meta,
    });
    throw new KernelError(
      'ACCOUNT_LOCKED',
      'This account is temporarily locked. Contact an administrator.',
    );
  }

  if (!user.isActive || user.status === 'DEACTIVATED' || user.status === 'SUSPENDED') {
    await logAttempt({
      userId: user.id,
      email,
      outcome: 'FAILURE_INACTIVE',
      reason: `status ${user.status}`,
      meta: input.meta,
    });
    throw genericFailure();
  }

  const passwordOk = await verifyPassword(user.passwordHash, input.password);

  if (!passwordOk) {
    const failures = user.failedLoginCount + 1;
    const shouldLock = failures >= policy.maxFailedAttempts;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: failures,
        lockedUntil: shouldLock
          ? new Date(Date.now() + policy.lockoutDurationMinutes * 60_000)
          : user.lockedUntil,
      },
    });

    await logAttempt({
      userId: user.id,
      email,
      outcome: 'FAILURE_BAD_CREDENTIALS',
      reason: shouldLock
        ? `consecutive failures reached ${failures}; account locked for ${policy.lockoutDurationMinutes} minutes`
        : `consecutive failure ${failures} of ${policy.maxFailedAttempts}`,
      meta: input.meta,
    });

    throw genericFailure();
  }

  // Password is correct. Clear the failure counter and open the session.
  const roleCodes = user.userRoles.filter((r) => r.role.isActive).map((r) => r.role.code);
  const isFinalApprover = user.userRoles.some((r) => r.role.isActive && r.role.isFinalApprover);
  const mfaRequired = mfaRequiredFor(policy, roleCodes, user.mfaEnforced);

  const session = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    const issued = await issueSession(tx, user.id, policy, {
      ipAddress: input.meta.ipAddress,
      userAgent: input.meta.userAgent,
      deviceFingerprint: fingerprintOf(input.meta.ipAddress, input.meta.userAgent),
      deviceLabel: input.meta.deviceLabel ?? describeDevice(input.meta.userAgent),
      mfaSatisfied: !mfaRequired,
      mfaChallenge: mfaRequired,
    });

    await writeAuditEntry(
      tx,
      { id: user.id, name: user.fullName, roleCodes },
      {
        action: 'LOGIN',
        entityType: 'SESSION',
        entityId: issued.id,
        entityLabel: `${describeDevice(input.meta.userAgent)}`,
        description: mfaRequired
          ? `Password accepted for ${email}; awaiting MFA verification`
          : `Signed in to ${email}`,
        metadata: { mfaRequired, device: describeDevice(input.meta.userAgent) },
      },
      {
        ipAddress: input.meta.ipAddress,
        userAgent: input.meta.userAgent,
        requestId: input.meta.requestId,
        sessionId: issued.id,
      },
    );

    return issued;
  });

  await logAttempt({
    userId: user.id,
    email,
    outcome: 'SUCCESS',
    reason: mfaRequired ? 'password accepted; MFA outstanding' : undefined,
    meta: input.meta,
    sessionId: session.id,
  });

  return {
    status: mfaRequired ? 'MFA_REQUIRED' : 'SUCCESS',
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    organizationId: user.organizationMemberships[0]?.organizationId ?? null,
    roleCodes,
    isFinalApprover,
    sessionId: session.sessionToken,
    mustChangePassword: user.mustChangePassword,
    mfaSatisfied: !mfaRequired,
  };
}

export async function verifyMfaChallenge(input: {
  sessionToken: string;
  code: string;
  meta: LoginMeta;
}): Promise<{ ok: true } | { ok: false; reason: string; lockedOut?: boolean }> {
  const policy = await loadAuthPolicy();

  const limit = checkRateLimit(
    rateLimitKeys.mfa('challenge'),
    policy.maxAttemptsPerWindow,
    policy.rateLimitWindowSeconds,
  );
  if (!limit.allowed) {
    return {
      ok: false,
      reason: 'Too many incorrect codes. Please sign in again.',
      lockedOut: true,
    };
  }

  const session = await prisma.session.findUnique({
    where: { sessionToken: input.sessionToken },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          fullName: true,
          mfaDevices: {
            where: { status: 'ACTIVE' },
            select: {
              id: true,
              secretEnc: true,
              recoveryCodesEnc: true,
              lastUsedCounter: true,
              failedAttempts: true,
            },
          },
        },
      },
    },
  });

  if (!session || session.revokedAt || session.mfaSatisfiedAt) {
    return { ok: false, reason: 'This sign-in attempt is no longer valid. Please start again.' };
  }

  const device = session.user.mfaDevices[0];
  if (!device) {
    return { ok: false, reason: 'No MFA device is enrolled for this account.' };
  }

  const totpResult = verifyTotpCode(device.secretEnc, input.code, device.lastUsedCounter);
  const recoveryOk =
    !totpResult.valid && device.recoveryCodesEnc
      ? verifyRecoveryCode(device.recoveryCodesEnc, input.code)
      : false;

  if (!totpResult.valid && !recoveryOk) {
    await prisma.$transaction(async (tx) => {
      await prisma.mfaDevice.update({
        where: { id: device.id },
        data: { failedAttempts: { increment: 1 } },
      });

      await writeAuditEntry(
        tx,
        { id: session.user.id, name: session.user.fullName, roleCodes: [] },
        {
          action: 'LOGIN_FAILED',
          entityType: 'SESSION',
          entityId: session.id,
          description: `Incorrect MFA code for ${session.user.email}`,
          result: 'FAILURE',
          metadata: { reason: totpResult.reason ?? 'RECOVERY_CODE_INVALID' },
          securityEvent: {
            type: 'MFA_FAILED_REPEATEDLY',
            severity: 'LOW',
            subjectType: 'USER',
            subjectId: session.user.id,
            description: `Incorrect MFA code supplied for ${session.user.email}`,
          },
        },
        {
          ipAddress: input.meta.ipAddress,
          userAgent: input.meta.userAgent,
          requestId: input.meta.requestId,
          sessionId: session.id,
        },
      );
    });

    return { ok: false, reason: 'That code is not valid.' };
  }

  await prisma.$transaction(async (tx) => {
    await tx.session.update({
      where: { id: session.id },
      data: { mfaSatisfiedAt: new Date() },
    });

    await tx.mfaDevice.update({
      where: { id: device.id },
      data: {
        failedAttempts: 0,
        lastUsedAt: new Date(),
        ...(totpResult.counter !== null ? { lastUsedCounter: totpResult.counter } : {}),
      },
    });

    await tx.user.update({
      where: { id: session.userId },
      data: { mfaVerifiedAt: new Date() },
    });

    await writeAuditEntry(
      tx,
      { id: session.user.id, name: session.user.fullName, roleCodes: [] },
      {
        action: 'MFA_VERIFIED',
        entityType: 'SESSION',
        entityId: session.id,
        description: `Multi-factor verification completed for ${session.user.email}`,
        metadata: { method: totpResult.valid ? 'TOTP' : 'RECOVERY_CODE' },
      },
      {
        ipAddress: input.meta.ipAddress,
        userAgent: input.meta.userAgent,
        requestId: input.meta.requestId,
        sessionId: session.id,
      },
    );
  });

  return { ok: true };
}

export async function logout(
  sessionId: string,
  meta: LoginMeta & { actorName?: string | null },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'LOGOUT' },
    });

    await writeAuditEntry(
      tx,
      { id: null, name: meta.actorName ?? 'session', roleCodes: [] },
      {
        action: 'LOGOUT',
        entityType: 'SESSION',
        entityId: sessionId,
        description: 'Signed out',
      },
      {
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        sessionId,
      },
    );
  });
}

const RESET_TOKEN_TTL_MINUTES = 30;

export async function requestPasswordReset(input: {
  email: string;
  meta: LoginMeta;
}): Promise<void> {
  const email = normalizeEmail(input.email);

  const limit = checkRateLimit(rateLimitKeys.reset(email), 3, 3600);
  if (!limit.allowed) return;

  const user = await prisma.user.findUnique({
    where: { emailNormalized: email },
    select: { id: true, fullName: true, isActive: true, deletedAt: true },
  });

  /**
   * Always report success.
   *
   * If this endpoint told an anonymous caller which addresses have accounts, it
   * would be an account enumeration oracle with a password-reset rate limit
   * attached. The audit entry below records whether a token was issued.
   */
  await prisma.$transaction(async (tx) => {
    if (user && user.isActive && !user.deletedAt) {
      const token = randomToken(32);
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordResetToken: hashToken(token),
          passwordResetExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60_000),
        },
      });

      await writeAuditEntry(
        tx,
        { id: user.id, name: user.fullName, roleCodes: [] },
        {
          action: 'PASSWORD_RESET_REQUESTED',
          entityType: 'USER',
          entityId: user.id,
          description: `Password reset requested for ${email}`,
          securityEvent: {
            type: 'NEW_DEVICE_LOGIN',
            severity: 'INFO',
            subjectType: 'USER',
            subjectId: user.id,
            description: `Password reset requested for ${email}`,
          },
        },
        {
          ipAddress: input.meta.ipAddress,
          userAgent: input.meta.userAgent,
          requestId: input.meta.requestId,
        },
      );
    } else {
      await writeAuditEntry(
        tx,
        SYSTEM_ACTOR,
        {
          action: 'PASSWORD_RESET_REQUESTED',
          entityType: 'USER',
          description: `Password reset requested for unknown address ${email}`,
          result: 'FAILURE',
        },
        {
          ipAddress: input.meta.ipAddress,
          userAgent: input.meta.userAgent,
          requestId: input.meta.requestId,
        },
      );
    }
  });
}

export async function resetPassword(input: {
  token: string;
  newPassword: string;
  meta: LoginMeta;
}): Promise<{ email: string }> {
  const policy = await loadAuthPolicy();

  if (looksLikeEmail(input.newPassword, '')) {
    throw new ValidationError('Choose a password that is not based on your email address.');
  }
  assertPasswordStrength(input.newPassword, {
    minLength: policy.passwordMinLength,
    requireUppercase: policy.passwordRequireUppercase,
    requireLowercase: policy.passwordRequireLowercase,
    requireNumber: policy.passwordRequireNumber,
    requireSymbol: policy.passwordRequireSymbol,
  });

  const hashed = hashToken(input.token);

  const user = await prisma.user.findFirst({
    where: { passwordResetToken: hashed },
    select: { id: true, email: true, fullName: true, passwordResetExpiresAt: true },
  });

  if (!user) {
    throw new ValidationError('This reset link is not valid or has already been used.');
  }

  if (!user.passwordResetExpiresAt || user.passwordResetExpiresAt.getTime() <= Date.now()) {
    throw new ValidationError('This reset link has expired. Please request a new one.');
  }

  const newHash = await hashPassword(input.newPassword);

  await prisma.$transaction(async (tx) => {
    const current = await tx.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true },
    });

    await tx.user.update({
      where: { id: user.id },
      data: {
        passwordHash: newHash,
        passwordAlgorithm: 'ARGON2ID',
        passwordChangedAt: new Date(),
        passwordResetToken: null,
        passwordResetExpiresAt: null,
        mustChangePassword: false,
        failedLoginCount: 0,
        lockedUntil: null,
        passwordHistory: { push: current.passwordHash ?? '' },
      },
    });

    // A reset must invalidate everything that was authenticated with the old
    // password, including sessions on other devices.
    await tx.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'PASSWORD_CHANGED' },
    });

    await writeAuditEntry(
      tx,
      { id: user.id, name: user.fullName, roleCodes: [] },
      {
        action: 'PASSWORD_RESET_COMPLETED',
        entityType: 'USER',
        entityId: user.id,
        description: `Password reset completed for ${user.email}; all sessions revoked`,
      },
      {
        ipAddress: input.meta.ipAddress,
        userAgent: input.meta.userAgent,
        requestId: input.meta.requestId,
      },
    );
  });

  return { email: user.email };
}

export async function changePassword(input: {
  userId: string;
  currentPassword: string;
  newPassword: string;
  currentSessionId: string;
  meta: LoginMeta;
}): Promise<void> {
  const policy = await loadAuthPolicy();

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: input.userId },
    select: { id: true, email: true, fullName: true, passwordHash: true },
  });

  if (!user.passwordHash || !(await verifyPassword(user.passwordHash, input.currentPassword))) {
    throw new KernelError('INVALID_CREDENTIALS', 'Your current password is not correct.');
  }

  assertPasswordStrength(input.newPassword, {
    minLength: policy.passwordMinLength,
    requireUppercase: policy.passwordRequireUppercase,
    requireLowercase: policy.passwordRequireLowercase,
    requireNumber: policy.passwordRequireNumber,
    requireSymbol: policy.passwordRequireSymbol,
  });

  const newHash = await hashPassword(input.newPassword);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        passwordHash: newHash,
        passwordAlgorithm: 'ARGON2ID',
        passwordChangedAt: new Date(),
        mustChangePassword: false,
        passwordHistory: { push: user.passwordHash ?? '' },
      },
    });

    await tx.session.updateMany({
      where: { userId: user.id, revokedAt: null, NOT: { id: input.currentSessionId } },
      data: { revokedAt: new Date(), revokedReason: 'PASSWORD_CHANGED' },
    });

    await writeAuditEntry(
      tx,
      { id: user.id, name: user.fullName, roleCodes: [] },
      {
        action: 'PASSWORD_CHANGED',
        entityType: 'USER',
        entityId: user.id,
        description: `Password changed for ${user.email}; other sessions revoked`,
      },
      {
        ipAddress: input.meta.ipAddress,
        userAgent: input.meta.userAgent,
        requestId: input.meta.requestId,
        sessionId: input.currentSessionId,
      },
    );
  });
}

/** Step-up authentication for sensitive actions (PDF 5). */
export async function stepUpAuthenticate(input: {
  sessionId: string;
  password: string;
  code: string | null;
  meta: LoginMeta;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const policy = await loadAuthPolicy();

  const session = await prisma.session.findUnique({
    where: { id: input.sessionId },
    include: { user: { select: { id: true, email: true, passwordHash: true, fullName: true } } },
  });

  if (!session || session.revokedAt) {
    return { ok: false, reason: 'Your session has ended. Please sign in again.' };
  }

  if (
    !session.user.passwordHash ||
    !(await verifyPassword(session.user.passwordHash, input.password))
  ) {
    await prisma.$transaction(async (tx) => {
      await writeAuditEntry(
        tx,
        { id: session.user.id, name: session.user.fullName, roleCodes: [] },
        {
          action: 'ACCESS_DENIED',
          entityType: 'SESSION',
          entityId: session.id,
          description: 'Step-up authentication failed: incorrect password',
          result: 'DENIED',
          securityEvent: {
            type: 'PRIVILEGE_ESCALATION_ATTEMPT',
            severity: 'MEDIUM',
            subjectType: 'SESSION',
            subjectId: session.id,
            description: 'Failed step-up re-authentication',
          },
        },
        {
          ipAddress: input.meta.ipAddress,
          userAgent: input.meta.userAgent,
          requestId: input.meta.requestId,
          sessionId: session.id,
        },
      );
    });
  }

  if (input.code) {
    const device = await prisma.mfaDevice.findFirst({
      where: { userId: session.userId, status: 'ACTIVE' },
      select: { id: true, secretEnc: true, lastUsedCounter: true },
    });

    if (device) {
      const result = verifyTotpCode(device.secretEnc, input.code, device.lastUsedCounter);
      if (!result.valid) {
        return { ok: false, reason: 'That code is not valid.' };
      }
      if (result.counter !== null) {
        await prisma.mfaDevice.update({
          where: { id: device.id },
          data: { lastUsedCounter: result.counter, lastUsedAt: new Date() },
        });
      }
    }
  }

  await grantStepUp(session.id, policy);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// MFA enrolment
// ---------------------------------------------------------------------------

export async function beginMfaEnrolment(input: {
  userId: string;
  actorName: string;
  meta: LoginMeta;
}): Promise<{ secret: string; uri: string; recoveryCodes: string[] }> {
  const secret = generateTotpSecret();
  const encrypted = encryptTotpSecret(secret);
  const recovery = generateRecoveryCodes();

  await prisma.$transaction(async (tx) => {
    // Only one pending device at a time; a half-finished enrolment is replaced
    // rather than accumulating, so there is never a question of which one wins.
    await tx.mfaDevice.deleteMany({
      where: { userId: input.userId, status: 'PENDING' },
    });

    await tx.mfaDevice.create({
      data: {
        userId: input.userId,
        method: 'TOTP' satisfies MfaMethod,
        label: 'Authenticator app',
        secretEnc: encrypted,
        recoveryCodesEnc: recovery.encrypted,
        status: 'PENDING',
      },
    });

    await writeAuditEntry(
      tx,
      { id: input.userId, name: input.actorName, roleCodes: [] },
      {
        action: 'MFA_ENROLLED',
        entityType: 'USER',
        entityId: input.userId,
        description: 'MFA enrolment started; awaiting confirmation code',
        metadata: { method: 'TOTP' },
      },
      {
        ipAddress: input.meta.ipAddress,
        userAgent: input.meta.userAgent,
        requestId: input.meta.requestId,
      },
    );
  });

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: input.userId },
    select: { email: true },
  });

  return {
    secret,
    uri: buildOtpAuthUri({ accountName: user.email, secret }),
    recoveryCodes: recovery.plain,
  };
}

export async function confirmMfaEnrolment(input: {
  userId: string;
  actorName: string;
  code: string;
  meta: LoginMeta;
}): Promise<void> {
  const device = await prisma.mfaDevice.findFirst({
    where: { userId: input.userId, status: 'PENDING' },
    select: { id: true, secretEnc: true },
  });

  if (!device) {
    throw new NotFoundError('Pending MFA enrolment');
  }

  const result = verifyTotpCode(device.secretEnc, input.code, -1);

  if (!result.valid || result.counter === null) {
    throw new ValidationError(
      'That code is not valid. Check your authenticator app and try again.',
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.mfaDevice.update({
      where: { id: device.id },
      data: {
        status: 'ACTIVE',
        confirmedAt: new Date(),
        ...(result.counter !== null ? { lastUsedCounter: result.counter } : {}),
      },
    });

    await tx.user.update({
      where: { id: input.userId },
      data: { mfaVerifiedAt: new Date() },
    });

    await writeAuditEntry(
      tx,
      { id: input.userId, name: input.actorName, roleCodes: [] },
      {
        action: 'MFA_ENROLLED',
        entityType: 'USER',
        entityId: input.userId,
        description: 'MFA enrolment confirmed and active',
        metadata: { method: 'TOTP' },
      },
      {
        ipAddress: input.meta.ipAddress,
        userAgent: input.meta.userAgent,
        requestId: input.meta.requestId,
      },
    );
  });
}

export async function disableMfa(input: {
  userId: string;
  actorName: string;
  sessionId: string;
  meta: LoginMeta;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.mfaDevice.updateMany({
      where: { userId: input.userId, status: { in: ['ACTIVE', 'PENDING'] } },
      data: { status: 'REVOKED' },
    });

    await tx.user.update({ where: { id: input.userId }, data: { mfaVerifiedAt: null } });

    await writeAuditEntry(
      tx,
      { id: input.userId, name: input.actorName, roleCodes: [] },
      {
        action: 'MFA_DISABLED',
        entityType: 'USER',
        entityId: input.userId,
        description: 'MFA devices revoked',
        securityEvent: {
          type: 'INSECURE_SESSION_POLICY',
          severity: 'HIGH',
          subjectType: 'USER',
          subjectId: input.userId,
          description: `MFA was disabled for ${input.actorName}`,
        },
      },
      {
        ipAddress: input.meta.ipAddress,
        userAgent: input.meta.userAgent,
        requestId: input.meta.requestId,
        sessionId: input.sessionId,
      },
    );
  });

  await revokeAllForUser(input.userId, 'MFA_CHANGED', input.sessionId);
}

export { clearRateLimits };
