import { z } from 'zod';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { hashPassword, assertPasswordStrength } from '@/lib/auth/password';
import { loadAuthPolicy } from '@/lib/auth/policy';
import { revokeAllForUser } from '@/lib/auth/session';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { KernelError, NotFoundError, ValidationError } from '@/lib/kernel/errors';

/**
 * /api/v1/users/[id]
 *
 * A single user. Activation and deactivation live here rather than on the
 * collection route because they are operations on one record, and because the
 * route segment config only types a `params` argument on a dynamic segment.
 *
 * The authorization check is the same one the Server Actions use. Taking the API
 * path is not a way around a permission check, because the check lives beneath
 * both rather than in either.
 */

async function auditOptions(reqId: string) {
  const h = await headers();
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, routeContext: RouteContext) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'USERS_ROLES', action: 'VIEW', entity: { type: 'USER' } });

    const { id } = await routeContext.params;

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        fullName: true,
        jobTitle: true,
        status: true,
        isActive: true,
        lastLoginAt: true,
        mfaEnforced: true,
        mfaVerifiedAt: true,
        deactivatedAt: true,
        deactivationReason: true,
        userRoles: {
          where: { revokedAt: null },
          select: {
            isTemporary: true,
            expiresAt: true,
            grantedAt: true,
            reason: true,
            role: { select: { code: true, name: true, isFinalApprover: true } },
          },
        },
        mfaDevices: { select: { id: true, status: true, confirmedAt: true, lastUsedAt: true } },
      },
    });

    if (!user || user.status === 'DEACTIVATED') {
      return apiError(new NotFoundError('User', id), reqId);
    }

    return ok({ data: user }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

const patchSchema = z.object({
  isActive: z.boolean(),
  reason: z.string().min(3).max(500),
  newPassword: z.string().optional(),
});

export async function PATCH(request: Request, routeContext: RouteContext) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'USERS_ROLES', action: 'EDIT', entity: { type: 'USER' } });

    const { id } = await routeContext.params;
    const body = patchSchema.parse(await request.json());

    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, emailNormalized: true, isActive: true },
    });
    if (!target) {
      return apiError(new NotFoundError('User', id), reqId);
    }

    /**
     * Without this, an administrator could deactivate themselves and lock everyone
     * out of the system. The correction is to grant the role to someone else
     * first, which leaves a trace.
     */
    if (id === ctx.actor.userId) {
      return apiError(
        new KernelError(
          'FORBIDDEN',
          'You cannot change your own active state through this endpoint.',
        ),
        reqId,
      );
    }

    let passwordHash: string | undefined;
    if (body.newPassword) {
      const policy = await loadAuthPolicy();
      assertPasswordStrength(body.newPassword, {
        minLength: policy.passwordMinLength,
        requireUppercase: policy.passwordRequireUppercase,
        requireLowercase: policy.passwordRequireLowercase,
        requireNumber: policy.passwordRequireNumber,
        requireSymbol: policy.passwordRequireSymbol,
      });
      passwordHash = await hashPassword(body.newPassword);
    }

    const net = await auditOptions(reqId);

    await withAudit(
      {
        organizationId: ctx.actor.organizationId,
        actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
        ipAddress: net.ipAddress,
        userAgent: net.userAgent,
        requestId: reqId,
        sessionId: ctx.actor.sessionId,
      },
      async (tx) => {
        await tx.user.update({
          where: { id },
          data: {
            ...(body.isActive
              ? { isActive: true, status: 'ACTIVE', deactivatedAt: null, deactivationReason: null }
              : {
                  isActive: false,
                  status: 'DEACTIVATED',
                  deactivatedAt: new Date(),
                  deactivationReason: body.reason,
                }),
            ...(passwordHash
              ? {
                  passwordHash,
                  passwordAlgorithm: 'ARGON2ID' as const,
                  passwordChangedAt: new Date(),
                  mustChangePassword: true,
                  failedLoginCount: 0,
                  lockedUntil: null,
                }
              : {}),
          },
        });

        await writeAuditEntry(
          tx,
          { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
          {
            action: body.isActive ? 'USER_ACTIVATED' : 'USER_DEACTIVATED',
            entityType: 'USER',
            entityId: id,
            entityLabel: target.emailNormalized,
            description: `${body.isActive ? 'Activated' : 'Deactivated'} ${target.emailNormalized} via API: ${body.reason}`,
            changes: { isActive: { from: target.isActive, to: body.isActive } },
            metadata: { passwordReset: Boolean(passwordHash) },
          },
          {
            organizationId: ctx.actor.organizationId,
            ipAddress: net.ipAddress,
            userAgent: net.userAgent,
            requestId: reqId,
            sessionId: ctx.actor.sessionId,
          },
        );
      },
    );

    /**
     * A deactivated account with a live session, or one whose password just
     * changed, is a hole in the control. Revocation is immediate, not on next
     * token expiry.
     */
    if (!body.isActive || passwordHash) {
      await revokeAllForUser(id, passwordHash ? 'PASSWORD_CHANGED' : 'ADMIN_REVOKED');
    }

    return ok({ data: { id, isActive: body.isActive } }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

/**
 * There is no DELETE. Accounts are deactivated, never deleted.
 *
 * A deleted user would take their audit trail's meaning with them: the entries
 * reference an actor that no longer exists, and "who deleted this person" becomes
 * unanswerable. Retention and erasure are handled by the retention policy in M17,
 * under legal review.
 */
export async function DELETE() {
  const reqId = await requestId();
  return apiError(
    new ValidationError(
      'Users are deactivated, not deleted. PATCH { "isActive": false, "reason": "..." } instead.',
    ),
    reqId,
  );
}
