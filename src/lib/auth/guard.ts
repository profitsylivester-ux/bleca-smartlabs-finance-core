import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/nxt-auth';
import { prisma } from '@/lib/db/prisma';
import type { ActorContext, RequestContext } from '@/lib/kernel/context';
import { AuthenticationError } from '@/lib/kernel/errors';
import { randomUUID } from 'node:crypto';

/**
 * The bridge from an HTTP request to a RequestContext.
 *
 * Everything downstream - service functions, authorize(), the audit writer -
 * takes a RequestContext and never touches cookies or Auth.js. That is what keeps
 * the kernel free of any knowledge of the transport, and what lets the same
 * service function be called from a Server Action, a route handler or a test
 * without behaving differently in any of the three.
 */

export interface CurrentActor extends ActorContext {
  mustChangePassword: boolean;
}

export async function currentActor(): Promise<CurrentActor | null> {
  const session = await auth();

  if (!session?.user?.id || !session.sessionId) return null;

  return {
    userId: session.user.id,
    email: session.user.email,
    fullName: session.user.fullName,
    roleCodes: session.user.roleCodes,
    isFinalApprover: session.user.isFinalApprover,
    organizationId: session.user.organizationId,
    sessionId: session.sessionId,
    mfaSatisfiedAt: session.mfaSatisfied ? new Date() : null,
    stepUpSatisfiedAt: null,
    stepUpExpiresAt: null,
    mustChangePassword: session.mustChangePassword,
  };
}

async function buildContext(): Promise<RequestContext> {
  const h = await headers();
  const actor = await currentActor();

  if (!actor) {
    throw new AuthenticationError('You are not signed in.');
  }

  return {
    actor,
    requestId: h.get('x-request-id') ?? randomUUID(),
    channel: (h.get('x-bleca-channel') as RequestContext['channel']) ?? 'WEB',
    idempotencyKey: h.get('idempotency-key'),
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    syncBatchId: h.get('x-sync-batch-id'),
  };
}

/**
 * For pages: redirect to sign-in if there is no usable session.
 *
 * MFA is enforced here rather than deeper in the application. A user whose
 * password is correct but whose second factor is outstanding must not reach any
 * page that could leak data, so they are sent to the challenge - not to the
 * dashboard with widgets disabled.
 */
export async function requirePageActor(): Promise<CurrentActor> {
  const session = await auth();

  if (!session?.user?.id) {
    redirect('/login');
  }

  if (!session.mfaSatisfied) {
    redirect('/mfa-verify');
  }

  if (session.mustChangePassword) {
    redirect('/settings/password');
  }

  const actor = await currentActor();
  if (!actor) redirect('/login');
  return actor;
}

/** For route handlers and server actions: throw rather than redirect. */
export async function requireContext(): Promise<RequestContext> {
  const session = await auth();

  if (!session?.user?.id) {
    throw new AuthenticationError('You are not signed in.');
  }

  if (!session.mfaSatisfied) {
    throw new AuthenticationError('Multi-factor verification is required.', 'MFA_REQUIRED');
  }

  return buildContext();
}

/** Context without the MFA gate, for the MFA challenge route itself. */
export async function requireChallengeContext(): Promise<RequestContext> {
  return buildContext();
}

export async function defaultOrganizationId(): Promise<string> {
  const org = await prisma.organization.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!org) {
    throw new Error('No organization exists. Run `npm run db:seed`.');
  }
  return org.id;
}
