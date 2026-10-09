/**
 * The unauthenticated shell.
 *
 * `instant = false` because every page here reads the session cookie in order to
 * decide whether to bounce an already-signed-in user away. That is a per-request
 * fact, so these routes cannot be prerendered.
 */
export const instant = false;

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
