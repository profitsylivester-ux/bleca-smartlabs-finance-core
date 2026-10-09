'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { headers } from 'next/headers';
import { randomUUID } from 'node:crypto';

/**
 * Delegation, access review and audit-trail actions.
 *
 * Delegation is the mechanism by which authority moves between people when the
 * CEO is unavailable. It is therefore the mechanism most likely to be misused to
 * launder a self-approval, so two rules are structural rather than advisory:
 *
 *   1. expiresAt is MANDATORY. An open-ended delegation is rejected by validation,
 *      not discouraged in a comment.
 *   2. Every delegation grants a role, never a raw permission set, so its reach is
 *      always describable as "what the CEO could do" rather than "whatever was
 *      ticked on a form".
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

const MAX_DELEGATION_DAYS = 90;

const delegationSchema = z.object({
  granteeId: z.string().min(1),
  roleId: z.string().min(1),
  kind: z.enum(['APPROVAL_AUTHORITY', 'TEMPORARY_ACCESS', 'ACTING_CAPACITY']),
  reason: z.string().min(3).max(500),
  startsAt: z.string().min(1),
  expiresAt: z.string().min(1),
});

export async function createDelegationAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const context = await ctx();
  await authorize(context, { module: 'USERS_ROLES', action: 'ADMINISTER' });

  const parsed = delegationSchema.safeParse({
    granteeId: String(formData.get('granteeId') ?? ''),
    roleId: String(formData.get('roleId') ?? ''),
    kind: String(formData.get('kind') ?? 'APPROVAL_AUTHORITY'),
    reason: String(formData.get('reason') ?? '').trim(),
    startsAt: String(formData.get('startsAt') ?? ''),
    expiresAt: String(formData.get('expiresAt') ?? ''),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? 'Check the details and try again.',
    };
  }

  const { granteeId, roleId, kind, reason, startsAt, expiresAt } = parsed.data;

  const starts = new Date(startsAt);
  const expires = new Date(expiresAt);

  if (Number.isNaN(expires.getTime()) || Number.isNaN(starts.getTime())) {
    return { ok: false, message: 'Enter a valid start and expiry date.' };
  }

  if (expires.getTime() <= starts.getTime()) {
    return { ok: false, message: 'The expiry must be after the start.' };
  }

  const days = (expires.getTime() - starts.getTime()) / 86_400_000;
  if (days > MAX_DELEGATION_DAYS) {
    return {
      ok: false,
      message: `A delegation may run for at most ${MAX_DELEGATION_DAYS} days. Extend it deliberately rather than granting a long one up front.`,
    };
  }

  if (granteeId === context.actor.userId) {
    return {
      ok: false,
      message:
        'You cannot delegate to yourself. Delegating to yourself would let one person both prepare and approve, which is the exact thing delegation must not enable.',
    };
  }

  const [grantee, role] = await Promise.all([
    prisma.user.findUnique({
      where: { id: granteeId },
      select: { id: true, emailNormalized: true },
    }),
    prisma.role.findUnique({ where: { id: roleId }, select: { id: true, code: true } }),
  ]);

  if (!grantee) return { ok: false, message: 'Unknown user.' };
  if (!role) return { ok: false, message: 'Unknown role.' };

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
      const delegation = await tx.delegation.create({
        data: {
          grantorId: context.actor.userId,
          granteeId,
          kind,
          roleId,
          reason,
          startsAt: starts,
          expiresAt: expires,
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
          action: 'DELEGATION_GRANTED',
          entityType: 'DELEGATION',
          entityId: delegation.id,
          entityLabel: `${grantee.emailNormalized} as ${role.code}`,
          description: `Delegated ${role.code} to ${grantee.emailNormalized} until ${expires.toISOString().slice(0, 10)}: ${reason}`,
          metadata: {
            kind,
            roleCode: role.code,
            startsAt: starts.toISOString(),
            expiresAt: expires.toISOString(),
          },
          securityEvent: {
            type: 'PRIVILEGE_ESCALATION_ATTEMPT',
            severity: 'INFO',
            subjectType: 'DELEGATION',
            subjectId: delegation.id,
            description: `Authority delegated: ${role.code} granted to ${grantee.emailNormalized}`,
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

  revalidatePath('/admin/delegations');
  return { ok: true, message: `Delegated ${role.code} to ${grantee.emailNormalized}.` };
}

export async function revokeDelegationAction(formData: FormData): Promise<ActionResult> {
  const context = await ctx();
  await authorize(context, { module: 'USERS_ROLES', action: 'ADMINISTER' });

  const delegationId = String(formData.get('delegationId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (!reason) return { ok: false, message: 'A reason is required.' };

  const delegation = await prisma.delegation.findUnique({
    where: { id: delegationId },
    select: {
      id: true,
      grantee: { select: { emailNormalized: true } },
      role: { select: { code: true } },
    },
  });

  if (!delegation) return { ok: false, message: 'Unknown delegation.' };

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
      await tx.delegation.update({
        where: { id: delegationId },
        data: {
          revokedAt: new Date(),
          revokedById: context.actor.userId,
          revocationReason: reason,
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
          action: 'DELEGATION_REVOKED',
          entityType: 'DELEGATION',
          entityId: delegationId,
          entityLabel: `${delegation.grantee.emailNormalized} as ${delegation.role?.code ?? 'unknown'}`,
          description: `Revoked delegation for ${delegation.grantee.emailNormalized}: ${reason}`,
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

  revalidatePath('/admin/delegations');
  return { ok: true, message: 'Delegation revoked.' };
}

export async function openAccessReviewAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const context = await ctx();
  await authorize(context, { module: 'USERS_ROLES', action: 'ADMINISTER' });

  const name = String(formData.get('name') ?? '').trim();
  const periodStart = String(formData.get('periodStart') ?? '');
  const periodEnd = String(formData.get('periodEnd') ?? '');

  if (!name) return { ok: false, message: 'Give the review a name.' };

  const start = new Date(periodStart || Date.now());
  const end = new Date(periodEnd || Date.now());

  if (end.getTime() <= start.getTime()) {
    return { ok: false, message: 'The review period must end after it starts.' };
  }

  const m = await meta();

  const review = await withAudit(
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
      const created = await tx.accessReview.create({
        data: {
          name,
          periodStart: start,
          periodEnd: end,
          initiatedById: context.actor.userId,
          scopeJson: { source: 'ALL_ACTIVE_GRANTS' },
        },
        select: { id: true },
      });

      /**
       * Snapshot every live grant into review items.
       *
       * Snapshotting, not pointing at the live rows: the review must record what
       * access looked like ON A DATE. If it read through to user_roles, someone
       * could add a grant during the review and it would appear in the paper
       * trail as though it had been there all along.
       */
      const grants = await tx.userRole.findMany({
        where: { revokedAt: null, role: { isActive: true } },
        select: { userId: true, roleId: true, expiresAt: true },
      });

      for (const grant of grants) {
        await tx.accessReviewItem.create({
          data: {
            reviewId: created.id,
            userId: grant.userId,
            roleId: grant.roleId,
            currentExpiresAt: grant.expiresAt,
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
          action: 'ACCESS_REVIEW_COMPLETED',
          entityType: 'ACCESS_REVIEW',
          entityId: created.id,
          entityLabel: name,
          description: `Opened access review "${name}" covering ${grants.length} active grant(s)`,
          result: 'SUCCESS',
          metadata: { items: grants.length },
        },
        {
          organizationId: context.actor.organizationId,
          ipAddress: m.ipAddress,
          userAgent: m.userAgent,
          requestId: m.requestId,
          sessionId: context.actor.sessionId,
        },
      );

      return created;
    },
  );

  revalidatePath('/admin/access-reviews');
  return {
    ok: true,
    message: `Review opened with ${review.id} item(s) to certify.`,
    data: { id: review.id },
  };
}

export async function decideReviewItemAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const context = await ctx();
  await authorize(context, { module: 'USERS_ROLES', action: 'ADMINISTER' });

  const itemId = String(formData.get('itemId') ?? '');
  const decision = String(formData.get('decision') ?? '');
  const decisionReason = String(formData.get('decisionReason') ?? '').trim();

  if (!['RETAIN', 'REVOKE', 'MODIFY'].includes(decision)) {
    return { ok: false, message: 'Unknown decision.' };
  }
  if (!decisionReason) {
    return { ok: false, message: 'Every access decision needs a recorded reason.' };
  }

  const item = await prisma.accessReviewItem.findUnique({
    where: { id: itemId },
    include: {
      user: { select: { emailNormalized: true, fullName: true } },
      role: { select: { code: true } },
      review: { select: { id: true, name: true } },
    },
  });

  if (!item) return { ok: false, message: 'Unknown review item.' };

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
      await tx.accessReviewItem.update({
        where: { id: itemId },
        data: {
          decision,
          decisionReason,
          decidedById: context.actor.userId,
          decidedAt: new Date(),
          actionedAt: new Date(),
        },
      });

      if (decision === 'REVOKE') {
        await tx.userRole.updateMany({
          where: { userId: item.userId, roleId: item.roleId, revokedAt: null },
          data: { revokedAt: new Date(), reason: `Access review: ${decisionReason}` },
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
          action: decision === 'REVOKE' ? 'ROLE_REMOVED' : 'ACCESS_REVIEW_COMPLETED',
          entityType: 'ACCESS_REVIEW',
          entityId: item.reviewId,
          entityLabel: item.review.name,
          description: `Access review decision ${decision} for ${item.user.emailNormalized} (${item.role.code}): ${decisionReason}`,
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

  revalidatePath('/admin/access-reviews');
  revalidatePath('/admin/users');
  return { ok: true, message: `Recorded: ${decision}.` };
}

/**
 * Revokes one live session.
 *
 * Takes a plain object rather than FormData because it is also called from
 * client components that are not a form. The authorization check is identical:
 * revoking someone's session is an access-control action, so it needs
 * (USERS_ROLES, ADMINISTER).
 */
export async function revokeSessionAction(input: {
  sessionId: string;
  reason: string;
}): Promise<ActionResult> {
  const context = await ctx();
  await authorize(context, { module: 'USERS_ROLES', action: 'ADMINISTER' });

  if (!input.reason.trim()) {
    return { ok: false, message: 'A reason is required.' };
  }

  const session = await prisma.session.findUnique({
    where: { id: input.sessionId },
    select: {
      id: true,
      revokedAt: true,
      user: { select: { emailNormalized: true } },
    },
  });

  if (!session) return { ok: false, message: 'Unknown session.' };
  if (session.revokedAt) return { ok: true, message: 'That session had already ended.' };

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
      await tx.session.update({
        where: { id: input.sessionId },
        data: { revokedAt: new Date(), revokedReason: 'ADMIN_REVOKED' },
      });

      await writeAuditEntry(
        tx,
        {
          id: context.actor.userId,
          name: context.actor.fullName,
          roleCodes: context.actor.roleCodes,
        },
        {
          action: 'SESSION_REVOKED',
          entityType: 'SESSION',
          entityId: input.sessionId,
          entityLabel: session.user.emailNormalized,
          description: `Revoked a session for ${session.user.emailNormalized}: ${input.reason}`,
          securityEvent: {
            type: 'PRIVILEGE_ESCALATION_ATTEMPT',
            severity: 'INFO',
            subjectType: 'SESSION',
            subjectId: input.sessionId,
            description: `Session revoked for ${session.user.emailNormalized}`,
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

  revalidatePath('/admin/users');
  return { ok: true, message: 'Session revoked. It stops working on the next request.' };
}
