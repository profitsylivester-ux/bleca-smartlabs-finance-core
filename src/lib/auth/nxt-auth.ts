import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { z } from 'zod';
import { headers } from 'next/headers';
import { attemptLogin, type LoginMeta } from '@/lib/auth/service';
import { loadAuthPolicy, mfaRequiredFor } from '@/lib/auth/policy';
import { validateAndTouchSession } from '@/lib/auth/session';
import { prisma } from '@/lib/db/prisma';
import { env } from '@/lib/env';
import { randomUUID } from 'node:crypto';

/**
 * Auth.js configuration.
 *
 * Auth.js owns the cookie, the JWT lifecycle and the sign-out ceremony. It does
 * NOT own authorisation: the JWT carries only a session id, and that id is
 * re-validated against the database on every request through the `session`
 * callback. That split is what makes "revoke this session now" actually revoke
 * it rather than waiting for a token to expire.
 */

const credentialsSchema = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
});

async function requestMeta(): Promise<LoginMeta> {
  const h = await headers();
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    deviceLabel: null,
    requestId: h.get('x-request-id') ?? randomUUID(),
  };
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  secret: env().AUTH_SECRET,
  basePath: '/api/auth',
  session: {
    // JWT mode. The session AUTHORITY lives in Postgres; the token is a pointer.
    strategy: 'jwt',
    maxAge: 60 * 60 * 12,
  },
  pages: {
    signIn: '/login',
    error: '/login',
  },
  cookies: {
    sessionToken: {
      name: '__Secure-bleca.session',
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: env().NODE_ENV === 'production',
      },
    },
  },
  providers: [
    /**
     * Password verification. Lockout, rate limiting and LoginHistory all live in
     * attemptLogin; this is a thin adapter so there is exactly ONE
     * implementation of "is this password correct", not two that could drift
     * apart and disagree about who is locked out.
     */
    Credentials({
      id: 'credentials',
      name: 'Email and password',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;

        const result = await attemptLogin({
          email: parsed.data.email,
          password: parsed.data.password,
          meta: await requestMeta(),
        });

        return sessionUserFrom(result);
      },
    }),

    /**
     * Session exchange. Exchanges an already-verified, already-open session row
     * for the Auth.js cookie.
     *
     * It exists so that a login is not verified twice. attemptLogin has already
     * checked the password, applied the lockout and written the audit entry;
     * running that path again through `credentials` would verify the same password
     * a second time, double-count the failed-attempt counter on a wrong password,
     * and leave two session rows per login.
     *
     * Possession of the token is the credential here, exactly as it is for a
     * session cookie. It is a 256-bit value that exists only in a server-side
     * row, so this grants no capability that holding the cookie would not.
     */
    Credentials({
      id: 'session-exchange',
      name: 'Session exchange',
      credentials: { token: { label: 'Session token', type: 'text' } },
      async authorize(raw) {
        const token = (raw as { token?: unknown } | undefined)?.token;
        if (typeof token !== 'string' || token.length < 20) return null;

        const validation = await validateAndTouchSession(token);
        if (!validation.valid || !validation.userId) return null;

        const user = await prisma.user.findUnique({
          where: { id: validation.userId },
          select: {
            id: true,
            email: true,
            fullName: true,
            isActive: true,
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

        if (!user || !user.isActive) return null;

        return sessionUserFrom({
          userId: user.id,
          email: user.email,
          fullName: user.fullName,
          organizationId: user.organizationMemberships[0]?.organizationId ?? null,
          roleCodes: user.userRoles.filter((r) => r.role.isActive).map((r) => r.role.code),
          isFinalApprover: user.userRoles.some((r) => r.role.isActive && r.role.isFinalApprover),
          mustChangePassword: false,
          sessionId: token,
        });
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        const u = user as unknown as {
          id: string;
          sid: string;
          organizationId: string | null;
          roleCodes: string[];
          isFinalApprover: boolean;
          mustChangePassword: boolean;
        };
        token.sid = u.sid;
        token.uid = u.id;
        token.orgId = u.organizationId;
        token.roles = u.roleCodes;
        token.finalApprover = u.isFinalApprover;
        token.mfaRequired = true;
        token.mfaSatisfied = true;
        token.mustChangePassword = u.mustChangePassword;
      }
      return token;
    },

    /**
     * Authoritative session resolution. One database read per request; that is
     * the cost of immediate revocation, and it is the right trade for a system
     * whose audit trail is only worth anything if it reflects reality.
     */
    async session({ session, token }) {
      const sid = token.sid;

      if (!sid) {
        return anonymousSession(session);
      }

      const validation = await validateAndTouchSession(sid);
      if (!validation.valid || !validation.userId) {
        return anonymousSession(session);
      }

      const user = await prisma.user.findUnique({
        where: { id: validation.userId },
        select: {
          id: true,
          email: true,
          fullName: true,
          isActive: true,
          mfaEnforced: true,
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

      if (!user || !user.isActive) {
        return anonymousSession(session);
      }

      const policy = await loadAuthPolicy();
      const roleCodes = user.userRoles.filter((r) => r.role.isActive).map((r) => r.role.code);
      const mfaRequired = mfaRequiredFor(policy, roleCodes, user.mfaEnforced);

      session.user = {
        ...session.user,
        id: user.id,
        email: user.email,
        name: user.fullName,
        fullName: user.fullName,
        organizationId: user.organizationMemberships[0]?.organizationId ?? null,
        roleCodes,
        isFinalApprover: user.userRoles.some((r) => r.role.isActive && r.role.isFinalApprover),
      } as typeof session.user;

      session.sessionId = sid;
      session.mfaSatisfied = validation.mfaSatisfied;
      session.mfaRequired = mfaRequired;
      session.mustChangePassword = token.mustChangePassword === true;

      return session;
    },
  },
});

/**
 * Shape handed back to Auth.js by either provider.
 *
 * The JWT carries only a pointer (sid) plus display facts. Permissions are
 * deliberately absent: they are resolved server-side per request, and a
 * permission list baked into a cookie would be a stale snapshot that invites
 * code to mistake a cookie claim for an authorisation.
 */
function sessionUserFrom(result: {
  userId: string;
  email: string;
  fullName: string;
  organizationId: string | null;
  roleCodes: string[];
  isFinalApprover: boolean;
  mustChangePassword: boolean;
  /** The open session row's token. Always required. */
  sessionId: string;
}) {
  return {
    id: result.userId,
    email: result.email,
    name: result.fullName,
    sid: result.sessionId,
    organizationId: result.organizationId,
    roleCodes: result.roleCodes,
    isFinalApprover: result.isFinalApprover,
    mustChangePassword: result.mustChangePassword,
  };
}

/**
 * A well-formed session that carries no user.
 *
 * Returning a blank session rather than null keeps the callback's return type
 * honest; requireUser() treats an empty id as unauthenticated.
 */
function anonymousSession(session: { user: unknown }) {
  return {
    ...session,
    user: {
      id: '',
      email: '',
      name: '',
      fullName: '',
      organizationId: null,
      roleCodes: [],
      isFinalApprover: false,
    },
    sessionId: '',
    mfaSatisfied: false,
    mfaRequired: false,
    mustChangePassword: false,
  } as never;
}
