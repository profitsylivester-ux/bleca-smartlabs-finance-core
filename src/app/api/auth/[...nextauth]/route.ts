import { handlers } from '@/lib/auth/nxt-auth';

/**
 * Auth.js route handler.
 *
 * The credential POST route is intentionally not exposed for interactive use:
 * sign-in happens through the server action in modules/auth/server/actions.ts,
 * which owns the MFA challenge flow. Auth.js still needs its own handlers for
 * the session and CSRF endpoints it manages internally.
 */
export const { GET, POST } = handlers;
