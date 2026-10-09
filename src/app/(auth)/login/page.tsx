import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/nxt-auth';
import { AuthFooterLink, AuthShell } from '@/modules/auth/components/auth-shell';
import { LoginForm } from '@/modules/auth/components/login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reset?: string }>;
}) {
  const session = await auth();
  if (session?.user?.id) {
    redirect(session.user.isFinalApprover ? '/dashboard/ceo' : '/dashboard/finance');
  }

  const { reset } = await searchParams;

  return (
    <AuthShell
      title="BLECA SmartLabs Finance"
      description="Sign in to continue"
      footer={
        <>
          <AuthFooterLink href="/forgot-password">Forgot your password?</AuthFooterLink>
          <p className="mt-3">
            Accounts are created by an administrator. There is no self sign-up.
          </p>
        </>
      }
    >
      {reset === 'complete' ? (
        <div className="text-positive mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-sm">
          Your password has been changed. Sign in with the new one.
        </div>
      ) : null}
      <LoginForm />
    </AuthShell>
  );
}
