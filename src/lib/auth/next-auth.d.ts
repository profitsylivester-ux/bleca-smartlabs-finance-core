import type { DefaultSession } from '@auth/core/types';

/**
 * Module augmentation for the Auth.js session and JWT.
 *
 * These augment `@auth/core/types` and `@auth/core/jwt`, NOT `next-auth`.
 *
 * `next-auth/index.d.ts` only re-exports those declarations, and a module
 * augmentation merges into declarations made in the target module rather than
 * into a re-export of them. Augmenting 'next-auth' type-checks cleanly and then
 * does nothing, which is a genuinely nasty failure: the code compiles and the new
 * fields silently come back as `{}`.
 *
 * Deliberately absent: permissions. A client-side list of permissions would be a
 * snapshot that goes stale the moment a role changes, and it would invite code
 * that treats a UI-visible permission as an authorisation. Permissions are read
 * server-side by lib/rbac on every request.
 */
declare module '@auth/core/types' {
  interface Session {
    user: {
      id: string;
      email: string;
      fullName: string;
      organizationId: string | null;
      roleCodes: string[];
      isFinalApprover: boolean;
    } & DefaultSession['user'];
    /** Server-side session row id. The JWT's `sid` claim. */
    sessionId: string;
    /** False while an MFA challenge is outstanding. */
    mfaSatisfied: boolean;
    mfaRequired: boolean;
    mustChangePassword: boolean;
  }
}

declare module '@auth/core/jwt' {
  interface JWT {
    sid?: string;
    uid?: string;
    orgId?: string | null;
    roles?: string[];
    finalApprover?: boolean;
    mfaSatisfied?: boolean;
    mfaRequired?: boolean;
    mustChangePassword?: boolean;
  }
}

export {};
