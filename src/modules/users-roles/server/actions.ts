'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { hashPassword } from '@/lib/auth/password';
import { loadAuthPolicy } from '@/lib/auth/policy';
import { assertPasswordStrength } from '@/lib/auth/password';
import { revokeAllForUser } from '@/lib/auth/session';
import { KernelError, ValidationError, NotFoundError } from '@/lib/kernel/errors';
import { beginMfaEnrolment, confirmMfaEnrolment, disableMfa } from '@/lib/auth/service';
import { headers } from 'next/headers';
import { randomUUID } from 'node:crypto';

/**
 * Users and roles server actions.
 *
 * Every function here follows the same shape:
 *   authorize() FIRST, mutation and audit in ONE transaction, revalidate after.
 *
 * Permission changes require step-up authentication. Granting permissions is the
 * highest-value action in this system - it is how you mint a new CEO - so a
 * stolen session cookie must not be sufficient to perform it.
 */

async function ctx() {
  return requireContext();
}

async function meta() {
  const h = await headers();
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: h.get('x-request-id') ?? randomUUID(),
  };
}

export interface ActionResult {
  ok: boolean;
  message?: string;
  data?: Record<string, unknown>;
}

const createUserSchema = z.object({
  email: z.string().email(),
  fullName: z.string().min(2).max(120),
  jobTitle: z.string().max(120).optional(),
  roleCode: z.string().min(1),
  temporary: z.boolean().default(false),
  expiresAt: z.string().optional(),
});

export async function createUserAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const context = await ctx();
  await authorize(context, { module: 'USERS_ROLES', action: 'CREATE' });

  const parsed = createUserSchema.safeParse({
    email: String(formData.get('email') ?? '').trim(),
    fullName: String(formData.get('fullName') ?? '').trim(),
    jobTitle: String(formData.get('jobTitle') ?? '').trim() || undefined,
    roleCode: String(formData.get('roleCode') ?? ''),
    temporary: formData.get('temporary') === 'on',
    expiresAt: String(formData.get('expiresAt') ?? '') || undefined,
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? 'Check the details and try again.',
    };
  }

  const { email, fullName, jobTitle, roleCode, temporary, expiresAt } = parsed.data;

  if (temporary && !expiresAt) {
    return {
      ok: false,
      message:
        'Temporary access needs an expiry date. Access that never expires is permanent access.',
    };
  }

  const emailNormalized = email.toLowerCase();

  const existing = await prisma.user.findUnique({
    where: { emailNormalized },
    select: { id: true },
  });
  if (existing) {
    return { ok: false, message: 'An account with that email address already exists.' };
  }

  const role = await prisma.role.findUnique({
    where: { code: roleCode },
    select: { id: true, code: true },
  });
  if (!role) return { ok: false, message: `Unknown role: ${roleCode}` };

  const m = await meta();

  await withAudit(
    {
      organizationId: context.actor.organizationId,
      actor: {
        id: context.actor.userId,
        name: context.actor.fullName,
        roleCodes: context.actor.roleCodes,
      },
      ipAddress: m.ipAddress,
      userAgent: m.userAgent,
      requestId: m.requestId,
      sessionId: context.actor.sessionId,
    },
    async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          emailNormalized,
          fullName,
          jobTitle: jobTitle ?? null,
          status: 'INVITED',
          isActive: true,
          userRoles: {
            create: {
              roleId: role.id,
              isTemporary: temporary,
              expiresAt: temporary && expiresAt ? new Date(expiresAt) : null,
              grantedById: context.actor.userId,
              reason: 'Account created by administrator',
            },
          },
          ...(context.actor.organizationId
            ? {
                organizationMemberships: {
                  create: { organizationId: context.actor.organizationId, isDefault: true },
                },
              }
            : {}),
        },
        select: { id: true },
      });

      await writeAuditEntry(
        tx,
        {
          id: context.actor.userId,
          name: context.actor.fullName,
          roleCodes: context.actor.roleCodes,
        },
        {
          action: 'USER_CREATED',
          entityType: 'USER',
          entityId: user.id,
          entityLabel: email,
          description: `Created account ${email} with role ${roleCode}${temporary ? ' (temporary access)' : ''}`,
          changes: {
            email: { from: null, to: email },
            fullName: { from: null, to: fullName },
            roleCode: { from: null, to: roleCode },
            temporary: { from: null, to: temporary },
          },
        },
        {
          organizationId: context.actor.organizationId,
          ipAddress: m.ipAddress,
          userAgent: m.userAgent,
          requestId: m.requestId,
          sessionId: context.actor.sessionId,
        },
      );

      await writeAuditEntry(
        tx,
        {
          id: context.actor.userId,
          name: context.actor.fullName,
          roleCodes: context.actor.roleCodes,
        },
        {
          action: 'ROLE_ASSIGNED',
          entityType: 'USER',
          entityId: user.id,
          entityLabel: email,
          description: `Assigned role ${roleCode} to ${email}`,
          metadata: { roleCode, temporary, expiresAt: temporary ? expiresAt : null },
        },
        {
          organizationId: context.actor.organizationId,
          ipAddress: m.ipAddress,
          userAgent: m.userAgent,
          requestId: m.requestId,
          sessionId: context.actor.sessionId,
        },
      );
    },
  );

  revalidatePath('/admin/users');
  return { ok: true, message: `Account created for ${email}.` };
}

export async function setUserActiveAction(formData: FormData): Promise<ActionResult> {
  const context = await ctx();
  await authorize(context, { module: 'USERS_ROLES', action: 'EDIT' });

  const userId = String(formData.get('userId') ?? '');
  const active = formData.get('active') === 'true';
  const reason = String(formData.get('reason') ?? '').trim();

  if (!reason) {
    return {
      ok: false,
      message: 'A reason is required. Deactivating someone is an audited action.',
    };
  }

  if (userId === context.actor.userId) {
    return { ok: false, message: 'You cannot deactivate your own account.' };
  }

  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, emailNormalized: true, isActive: true, fullName: true },
  });
  if (!target) throw new NotFoundError('User', userId);

  const m = await meta();

  await withAudit(
    {
      organizationId: context.actor.organizationId,
      actor: {
        id: context.actor.userId,
        name: context.actor.fullName,
        roleCodes: context.actor.roleCodes,
      },
      ipAddress: m.ipAddress,
      userAgent: m.userAgent,
      requestId: m.requestId,
      sessionId: context.actor.sessionId,
    },
    async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: active
          ? { isActive: true, status: 'ACTIVE', deactivatedAt: null, deactivationReason: null }
          : {
              isActive: false,
              status: 'DEACTIVATED',
              deactivatedAt: new Date(),
              deactivationReason: reason,
            },
      });

      await writeAuditEntry(
        tx,
        {
          id: context.actor.userId,
          name: context.actor.fullName,
          roleCodes: context.actor.roleCodes,
        },
        {
          action: active ? 'USER_ACTIVATED' : 'USER_DEACTIVATED',
          entityType: 'USER',
          entityId: userId,
          entityLabel: target.emailNormalized,
          description: active
            ? `Reactivated account ${target.emailNormalized}`
            : `Deactivated account ${target.emailNormalized}: ${reason}`,
          changes: { isActive: { from: target.isActive, to: active } },
        },
        {
          organizationId: context.actor.organizationId,
          ipAddress: m.ipAddress,
          userAgent: m.userAgent,
          requestId: m.requestId,
          sessionId: context.actor.sessionId,
        },
      );
    },
  );

  if (!active) {
    // A deactivated account with a live session would be a hole in the control.
    await revokeAllForUser(userId, 'ADMIN_REVOKED');
  }

  revalidatePath('/admin/users');
  return {
    ok: true,
    message: active ? 'Account reactivated.' : 'Account deactivated and sessions revoked.',
  };
}

export async function assignRoleAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const context = await ctx();
  // Step-up enforced: this is a permission change in substance.
  await authorize(context, { module: 'USERS_ROLES', action: 'ADMINISTER' });

  const userId = String(formData.get('userId') ?? '');
  const roleCode = String(formData.get('roleCode') ?? '');
  const action = String(formData.get('action') ?? 'grant');
  const reason = String(formData.get('reason') ?? '').trim();

  if (!reason)
    return { ok: false, message: 'A reason is required and is recorded in the audit trail.' };

  const [target, role] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, emailNormalized: true, fullName: true },
    }),
    prisma.role.findUnique({ where: { code: roleCode }, select: { id: true, code: true } }),
  ]);

  if (!target) throw new NotFoundError('User', userId);
  if (!role) return { ok: false, message: `Unknown role: ${roleCode}` };

  const m = await meta();

  await withAudit(
    {
      organizationId: context.actor.organizationId,
      actor: {
        id: context.actor.userId,
        name: context.actor.fullName,
        roleCodes: context.actor.roleCodes,
      },
      ipAddress: m.ipAddress,
      userAgent: m.userAgent,
      requestId: m.requestId,
      sessionId: context.actor.sessionId,
    },
    async (tx) => {
      if (action === 'revoke') {
        await tx.userRole.updateMany({
          where: { userId, roleId: role.id, revokedAt: null },
          data: { revokedAt: new Date(), reason },
        });
      } else {
        await tx.userRole.create({
          data: {
            userId,
            roleId: role.id,
            grantedById: context.actor.userId,
            grantedAt: new Date(),
            reason,
          },
        });
      }

      await writeAuditEntry(
        tx,
        {
          id: context.actor.userId,
          name: context.actor.fullName,
          roleCodes: context.actor.roleCodes,
        },
        {
          action: action === 'revoke' ? 'ROLE_REMOVED' : 'ROLE_ASSIGNED',
          entityType: 'USER',
          entityId: userId,
          entityLabel: target.emailNormalized,
          description:
            action === 'revoke'
              ? `Revoked role ${roleCode} from ${target.emailNormalized}: ${reason}`
              : `Granted role ${roleCode} to ${target.emailNormalized}: ${reason}`,
        },
        {
          organizationId: context.actor.organizationId,
          ipAddress: m.ipAddress,
          userAgent: m.userAgent,
          requestId: m.requestId,
          sessionId: context.actor.sessionId,
        },
      );
    },
  );

  // A role change must not wait for the target's cookie to expire.
  await revokeAllForUser(userId, 'ADMIN_REVOKED');

  revalidatePath('/admin/users');
  return { ok: true, message: action === 'revoke' ? 'Role revoked.' : 'Role granted.' };
}

export async function resetUserPasswordAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const context = await ctx();
  await authorize(context, { module: 'USERS_ROLES', action: 'EDIT' });

  const userId = String(formData.get('userId') ?? '');
  const newPassword = String(formData.get('newPassword') ?? '');

  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, emailNormalized: true, fullName: true },
  });
  if (!target) throw new NotFoundError('User', userId);

  const policy = await loadAuthPolicy();
  try {
    assertPasswordStrength(newPassword, {
      minLength: policy.passwordMinLength,
      requireUppercase: policy.passwordRequireUppercase,
      requireLowercase: policy.passwordRequireLowercase,
      requireNumber: policy.passwordRequireNumber,
      requireSymbol: policy.passwordRequireSymbol,
    });
  } catch (error) {
    const problems = (error as ValidationError).details?.problems;
    return {
      ok: false,
      message: Array.isArray(problems) ? problems.join(' ') : 'Password does not meet the policy.',
    };
  }

  const hashed = await hashPassword(newPassword);
  const m = await meta();

  await withAudit(
    {
      organizationId: context.actor.organizationId,
      actor: {
        id: context.actor.userId,
        name: context.actor.fullName,
        roleCodes: context.actor.roleCodes,
      },
      ipAddress: m.ipAddress,
      userAgent: m.userAgent,
      requestId: m.requestId,
      sessionId: context.actor.sessionId,
    },
    async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          passwordHash: hashed,
          passwordAlgorithm: 'ARGON2ID',
          passwordChangedAt: new Date(),
          mustChangePassword: true,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });

      await writeAuditEntry(
        tx,
        {
          id: context.actor.userId,
          name: context.actor.fullName,
          roleCodes: context.actor.roleCodes,
        },
        {
          action: 'PASSWORD_RESET_COMPLETED',
          entityType: 'USER',
          entityId: userId,
          entityLabel: target.emailNormalized,
          description: `Administrator reset the password for ${target.emailNormalized}; a change is required at next sign-in`,
          securityEvent: {
            type: 'INSECURE_SESSION_POLICY',
            severity: 'LOW',
            subjectType: 'USER',
            subjectId: userId,
            description: `Password was reset by an administrator for ${target.emailNormalized}`,
          },
        },
        {
          organizationId: context.actor.organizationId,
          ipAddress: m.ipAddress,
          userAgent: m.userAgent,
          requestId: m.requestId,
          sessionId: context.actor.sessionId,
        },
      );
    },
  );

  await revokeAllForUser(userId, 'PASSWORD_CHANGED');

  revalidatePath('/admin/users');
  return { ok: true, message: 'Password reset. The user must choose a new one at next sign-in.' };
}

export async function startMfaEnrolmentAction(userId: string): Promise<ActionResult> {
  const context = await ctx();
  await authorize(context, { module: 'USERS_ROLES', action: 'EDIT' });

  if (userId !== context.actor.userId) {
    await authorize(context, { module: 'USERS_ROLES', action: 'ADMINISTER' });
  }

  try {
    const enrolment = await beginMfaEnrolment({
      userId,
      actorName: context.actor.fullName,
      meta: await meta(),
    });

    return {
      ok: true,
      message: 'Scan the code with your authenticator app, then enter the six-digit code it shows.',
      data: {
        secret: enrolment.secret,
        uri: enrolment.uri,
        recoveryCodes: enrolment.recoveryCodes,
      },
    };
  } catch (error) {
    if (error instanceof KernelError) return { ok: false, message: error.message };
    throw error;
  }
}

export async function confirmMfaEnrolmentAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const context = await ctx();
  const userId = String(formData.get('userId') ?? '');
  const code = String(formData.get('code') ?? '').trim();

  if (userId !== context.actor.userId) {
    await authorize(context, { module: 'USERS_ROLES', action: 'ADMINISTER' });
  }

  try {
    await confirmMfaEnrolment({
      userId,
      actorName: context.actor.fullName,
      code,
      meta: await meta(),
    });
  } catch (error) {
    if (error instanceof KernelError) return { ok: false, message: error.message };
    throw error;
  }

  revalidatePath('/admin/users');
  revalidatePath('/settings/security');
  return { ok: true, message: 'MFA is now active on this account.' };
}

export async function disableMfaAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const context = await ctx();
  await authorize(context, { module: 'USERS_ROLES', action: 'ADMINISTER' });

  const userId = String(formData.get('userId') ?? '');

  await disableMfa({
    userId,
    actorName: context.actor.fullName,
    sessionId: context.actor.sessionId ?? '',
    meta: await meta(),
  });

  revalidatePath('/admin/users');
  return { ok: true, message: 'MFA devices revoked and other sessions ended.' };
}
