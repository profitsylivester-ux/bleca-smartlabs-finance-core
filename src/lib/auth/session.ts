import { randomBytes } from 'node:crypto';
import { prisma, type Tx } from '@/lib/db/prisma';
import type { AuthPolicy } from '@/generated/prisma/client';
import type { SessionRevokeReason } from '@/generated/prisma/client';

/**
 * Session lifecycle (PDF 4).
 *
 * The `sessions` row is the authority, not the JWT. The JWT only carries the
 * session id. That distinction is what makes revocation immediate: an admin
 * revoking a session takes effect on the next request, and a stolen cookie stops
 * working the moment the row is revoked - there is no window in which a
 * stateless token keeps asserting a right that has been withdrawn.
 *
 * Both timeouts are resolved from AuthPolicy at issue time and stored as absolute
 * instants. If the policy later tightens, live sessions keep the timeout they
 * were issued with rather than silently inheriting the new value, which would
 * mean a policy change could extend a session that was meant to be short-lived.
 */

export interface SessionIssueMeta {
  ipAddress: string | null;
  userAgent: string | null;
  deviceFingerprint: string | null;
  deviceLabel: string | null;
  mfaSatisfied: boolean;
  /** Shorter idle timeout while an MFA challenge is outstanding. */
  mfaChallenge?: boolean;
}

export async function issueSession(
  tx: Tx,
  userId: string,
  policy: AuthPolicy,
  meta: SessionIssueMeta,
): Promise<{
  id: string;
  sessionToken: string;
  absoluteExpiresAt: Date;
  idleTimeoutAt: Date | null;
}> {
  const now = new Date();
  const absoluteExpiresAt = new Date(
    now.getTime() + policy.sessionAbsoluteTimeoutHours * 3_600_000,
  );
  const idleMinutes = meta.mfaChallenge
    ? policy.mfaChallengeTimeoutMinutes
    : policy.sessionIdleTimeoutMinutes;
  const idleTimeoutAt = new Date(now.getTime() + idleMinutes * 60_000);

  const session = await tx.session.create({
    data: {
      sessionToken: randomBytes(32).toString('base64url'),
      userId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      deviceFingerprint: meta.deviceFingerprint,
      deviceLabel: meta.deviceLabel,
      createdAt: now,
      lastActiveAt: now,
      idleTimeoutAt,
      absoluteExpiresAt,
      mfaSatisfiedAt: meta.mfaSatisfied ? now : null,
    },
    select: { id: true, sessionToken: true, absoluteExpiresAt: true, idleTimeoutAt: true },
  });

  return session;
}

export type SessionInvalidReason =
  'NOT_FOUND' | 'REVOKED' | 'IDLE_TIMEOUT' | 'ABSOLUTE_TIMEOUT' | 'USER_INACTIVE' | 'USER_DELETED';

export interface SessionValidation {
  valid: boolean;
  reason: SessionInvalidReason | null;
  sessionId: string | null;
  userId: string | null;
  mfaSatisfied: boolean;
  mfaRequired: boolean;
  stepUpSatisfiedAt: Date | null;
  stepUpExpiresAt: Date | null;
  /** True when the caller should rotate the token (privilege change). */
  shouldRotate: boolean;
}

const INVALID: SessionValidation = {
  valid: false,
  reason: 'NOT_FOUND',
  sessionId: null,
  userId: null,
  mfaSatisfied: false,
  mfaRequired: false,
  stepUpSatisfiedAt: null,
  stepUpExpiresAt: null,
  shouldRotate: false,
};

/**
 * Validates a session and, on success, extends the idle deadline.
 *
 * The touch is a write on every request, which is intentional: it is what makes
 * an idle timeout mean "idle", rather than "since you last happened to ask
 * someone to extend it".
 */
export async function validateAndTouchSession(
  sessionToken: string,
  options: { touch?: boolean } = {},
): Promise<SessionValidation> {
  const session = await prisma.session.findUnique({
    where: { sessionToken },
    include: {
      user: {
        select: {
          id: true,
          status: true,
          isActive: true,
          deletedAt: true,
          mfaEnforced: true,
          email: true,
          fullName: true,
        },
      },
    },
  });

  if (!session) return INVALID;

  const now = new Date();

  if (session.revokedAt) {
    return { ...INVALID, reason: 'REVOKED', sessionId: session.id, userId: session.userId };
  }

  if (session.user.deletedAt) {
    return { ...INVALID, reason: 'USER_DELETED', sessionId: session.id, userId: session.userId };
  }

  if (
    !session.user.isActive ||
    session.user.status === 'DEACTIVATED' ||
    session.user.status === 'SUSPENDED'
  ) {
    return { ...INVALID, reason: 'USER_INACTIVE', sessionId: session.id, userId: session.userId };
  }

  if (session.absoluteExpiresAt.getTime() <= now.getTime()) {
    return {
      ...INVALID,
      reason: 'ABSOLUTE_TIMEOUT',
      sessionId: session.id,
      userId: session.userId,
    };
  }

  if (session.idleTimeoutAt && session.idleTimeoutAt.getTime() <= now.getTime()) {
    return { ...INVALID, reason: 'IDLE_TIMEOUT', sessionId: session.id, userId: session.userId };
  }

  if (options.touch !== false) {
    await prisma.session.update({
      where: { id: session.id },
      data: { lastActiveAt: now, idleTimeoutAt: new Date(now.getTime() + 30 * 60_000) },
    });
  }

  return {
    valid: true,
    reason: null,
    sessionId: session.id,
    userId: session.userId,
    mfaSatisfied: session.mfaSatisfiedAt !== null,
    mfaRequired: session.user.mfaEnforced,
    stepUpSatisfiedAt: session.stepUpSatisfiedAt,
    stepUpExpiresAt: session.stepUpExpiresAt,
    shouldRotate: false,
  };
}

export async function markMfaSatisfied(sessionId: string): Promise<void> {
  await prisma.session.update({
    where: { id: sessionId },
    data: { mfaSatisfiedAt: new Date() },
  });
}

export async function revokeSession(sessionId: string, reason: SessionRevokeReason): Promise<void> {
  await prisma.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

export async function revokeAllForUser(
  userId: string,
  reason: SessionRevokeReason,
  exceptSessionId?: string,
): Promise<number> {
  const result = await prisma.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptSessionId ? { NOT: { id: exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return result.count;
}

export async function grantStepUp(sessionId: string, policy: AuthPolicy): Promise<void> {
  const now = new Date();
  await prisma.session.update({
    where: { id: sessionId },
    data: {
      stepUpSatisfiedAt: now,
      stepUpExpiresAt: new Date(now.getTime() + policy.stepUpTimeoutMinutes * 60_000),
    },
  });
}

/** Consumes a step-up grant so a single re-authentication cannot authorise many actions. */
export async function consumeStepUp(sessionId: string): Promise<void> {
  await prisma.session.update({
    where: { id: sessionId },
    data: { stepUpSatisfiedAt: null, stepUpExpiresAt: null },
  });
}

export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /OPR\//.test(userAgent)
      ? 'Opera'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : /Firefox\//.test(userAgent)
            ? 'Firefox'
            : /curl/.test(userAgent)
              ? 'curl'
              : 'Browser';
  const platform = /Windows/.test(userAgent)
    ? 'Windows'
    : /Mac OS/.test(userAgent)
      ? 'macOS'
      : /Android/.test(userAgent)
        ? 'Android'
        : /iPhone|iPad/.test(userAgent)
          ? 'iOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : '';
  return platform ? `${browser} on ${platform}` : browser;
}

export function fingerprintOf(ip: string | null, userAgent: string | null): string | null {
  if (!userAgent) return null;
  return `${ip ?? 'unknown'}|${userAgent.slice(0, 120)}`;
}
