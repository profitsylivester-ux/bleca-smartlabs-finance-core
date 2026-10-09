'use server';

import { redirect } from 'next/navigation';
import { cookies, headers } from 'next/headers';
import { signOut, signIn } from '@/lib/auth/nxt-auth';
import {
  attemptLogin,
  requestPasswordReset,
  resetPassword,
  stepUpAuthenticate,
  verifyMfaChallenge,
} from '@/lib/auth/service';
import { revokeSession } from '@/lib/auth/session';
import { invalidateAuthPolicyCache } from '@/lib/auth/policy';
import { prisma } from '@/lib/db/prisma';
import { writeAuditEntry, SYSTEM_ACTOR } from '@/lib/audit/writer';
import { KernelError } from '@/lib/kernel/errors';
import { randomUUID } from 'node:crypto';

/**
 * Holds the verified session token between "password accepted" and "Auth.js
 * cookie issued". Short-lived, httpOnly, and cleared immediately after use.
 */
const PENDING_SESSION_COOKIE = 'bleca_pending_session';

/**
 * Auth server actions.
 *
 * Errors are returned as values, never thrown. A thrown error would land the user
 * on a generic error page; the caller needs to distinguish "wrong password" from
 * "account locked" from "too many attempts" in order to say something useful.
 */

export interface ActionResult {
  ok: boolean;
  message?: string;
  fieldErrors?: Record<string, string>;
}

async function meta() {
  const h = await headers();
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    deviceLabel: null,
    requestId: h.get('x-request-id') ?? randomUUID(),
  };
}

export async function loginAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');

  if (!email || !password) {
    return { ok: false, message: 'Enter your email address and password.' };
  }

  let result: Awaited<ReturnType<typeof attemptLogin>>;
  try {
    result = await attemptLogin({ email, password, meta: await meta() });
  } catch (error) {
    // KernelError carries the specific, user-actionable reason. Anything else is
    // a genuine failure and is re-thrown rather than shown as "wrong password".
    if (error instanceof KernelError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }

  const store = await cookies();
  store.set(PENDING_SESSION_COOKIE, result.sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 15 * 60,
  });

  if (result.status === 'MFA_REQUIRED') {
    redirect('/mfa-verify');
  }

  await signIn('session-exchange', { token: result.sessionId, redirect: false });
  store.delete(PENDING_SESSION_COOKIE);
  redirect(result.isFinalApprover ? '/dashboard/ceo' : '/dashboard/finance');
}

export async function mfaVerifyAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const code = String(formData.get('code') ?? '').trim();

  if (!code) {
    return { ok: false, message: 'Enter the 6-digit code from your authenticator app.' };
  }

  const store = await cookies();
  const pending = store.get(PENDING_SESSION_COOKIE)?.value;

  if (!pending) {
    redirect('/login');
  }

  const result = await verifyMfaChallenge({
    sessionToken: pending,
    code,
    meta: await meta(),
  });

  if (!result.ok) {
    return { ok: false, message: result.reason };
  }

  await signIn('session-exchange', { token: pending, redirect: false });
  store.delete(PENDING_SESSION_COOKIE);
  redirect('/dashboard');
}

export async function logoutAction(): Promise<void> {
  const { auth } = await import('@/lib/auth/nxt-auth');
  const session = await auth();
  if (session?.sessionId) {
    await revokeSession(session.sessionId, 'LOGOUT');
  }
  await signOut({ redirect: false });
  redirect('/login');
}

export async function forgotPasswordAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const email = String(formData.get('email') ?? '').trim();
  if (!email) return { ok: false, message: 'Enter your email address.' };

  await requestPasswordReset({ email, meta: await meta() });

  // Deliberately the same message whether or not the address exists.
  return {
    ok: true,
    message:
      'If that address belongs to an account, a reset link is on its way. The link expires in 30 minutes.',
  };
}

export async function resetPasswordAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const token = String(formData.get('token') ?? '');
  const password = String(formData.get('password') ?? '');
  const confirm = String(formData.get('confirmPassword') ?? '');

  if (!token) return { ok: false, message: 'This reset link is incomplete. Request a new one.' };
  if (password !== confirm) return { ok: false, message: 'The two passwords do not match.' };

  try {
    await resetPassword({ token, newPassword: password, meta: await meta() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The reset could not be completed.';
    return { ok: false, message };
  }

  redirect('/login?reset=complete');
}

export async function changePasswordAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const currentPassword = String(formData.get('currentPassword') ?? '');
  const password = String(formData.get('password') ?? '');
  const confirm = String(formData.get('confirmPassword') ?? '');

  if (!currentPassword || !password) {
    return { ok: false, message: 'Enter your current password and a new password.' };
  }
  if (password !== confirm) {
    return { ok: false, message: 'The two passwords do not match.' };
  }

  const { changePassword } = await import('@/lib/auth/service');
  const { auth } = await import('@/lib/auth/nxt-auth');
  const session = await auth();

  if (!session?.sessionId) redirect('/login');

  try {
    await changePassword({
      userId: session.user.id,
      currentPassword,
      newPassword: password,
      currentSessionId: session.sessionId,
      meta: await meta(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The password could not be changed.';
    return { ok: false, message };
  }

  redirect('/dashboard');
}

/**
 * Step-up re-authentication for a sensitive action.
 *
 * Consumes the grant immediately: one re-authentication authorises one action.
 * A grant that could be reused for a burst of changes would undo the point of
 * asking for the password again.
 */
export async function stepUpAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const password = String(formData.get('password') ?? '');
  const code = String(formData.get('code') ?? '').trim() || null;

  const { auth } = await import('@/lib/auth/nxt-auth');
  const session = await auth();
  if (!session?.sessionId) redirect('/login');

  const result = await stepUpAuthenticate({
    sessionId: session.sessionId,
    password,
    code,
    meta: await meta(),
  });

  if (!result.ok) return { ok: false, message: result.reason };
  return { ok: true, message: 'Identity re-confirmed. You can continue.' };
}

/**
 * Password reset token consumption from the emailed link.
 *
 * The token is stored hashed; this lookup only decides which row to hand to the
 * reset service, which performs the real single-use enforcement.
 */
export async function resolveResetToken(
  token: string,
): Promise<{ valid: boolean; email?: string }> {
  if (!token) return { valid: false };
  const { hashToken } = await import('@/lib/crypto');
  const user = await prisma.user.findFirst({
    where: { passwordResetToken: hashToken(token) },
    select: { email: true, passwordResetExpiresAt: true, isActive: true },
  });

  if (
    !user ||
    !user.passwordResetExpiresAt ||
    user.passwordResetExpiresAt.getTime() <= Date.now()
  ) {
    return { valid: false };
  }
  return { valid: true, email: user.email };
}

export async function recordSecurityNote(input: {
  action: 'CONFIGURATION_CHANGES' | 'SECURITY_EVENT';
  description: string;
  entityType: 'AUTH_POLICY' | 'SYSTEM';
  entityId?: string | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await writeAuditEntry(tx, SYSTEM_ACTOR, {
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      description: input.description,
      metadata: input.detail,
    });
  });
  invalidateAuthPolicyCache();
}
