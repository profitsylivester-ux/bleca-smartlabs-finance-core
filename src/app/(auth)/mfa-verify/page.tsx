import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Alert } from '@/components/ui';
import { AuthShell } from '@/modules/auth/components/auth-shell';
import { MfaVerifyForm } from '@/modules/auth/components/mfa-verify-form';

export const metadata: Metadata = { title: 'Two-factor verification' };

const PENDING_SESSION_COOKIE = 'bleca_pending_session';

export default async function MfaVerifyPage() {
  const store = await cookies();
  const pending = store.get(PENDING_SESSION_COOKIE)?.value;

  // No outstanding challenge means there is nothing to verify. Sending the user
  // back to sign-in is correct: it is not an error state, it is a stale link.
  if (!pending) {
    redirect('/login');
  }

  return (
    <AuthShell
      title="Two-factor verification"
      description="One more step to protect your account"
      footer={
        <p>
          Your password was accepted, but this account requires a second factor before any data is
          shown.
        </p>
      }
    >
      <div className="mb-4">
        <Alert tone="info">
          Open your authenticator app and enter the current six-digit code. Codes rotate every 30
          seconds.
        </Alert>
      </div>
      <MfaVerifyForm />
    </AuthShell>
  );
}
