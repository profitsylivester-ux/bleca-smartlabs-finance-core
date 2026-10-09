import type { Metadata } from 'next';
import { AuthShell } from '@/modules/auth/components/auth-shell';
import { ResetPasswordForm } from '@/modules/auth/components/password-forms';
import { resolveResetToken } from '@/modules/auth/server/actions';

export const metadata: Metadata = { title: 'Choose a new password' };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token = '' } = await searchParams;
  const { valid, email } = await resolveResetToken(token);

  if (!valid) {
    return (
      <AuthShell title="This link is not valid" description="Request a new one to continue">
        <div className="space-y-4 text-sm">
          <p className="text-foreground">
            This reset link has already been used, has expired, or does not exist. Reset links are
            valid for 30 minutes and can only be used once.
          </p>
          <a
            href="/forgot-password"
            className="text-navy-600 inline-block font-medium underline underline-offset-4"
          >
            Request a new link
          </a>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Choose a new password" description={email ? `For ${email}` : undefined}>
      <ResetPasswordForm token={token} />
    </AuthShell>
  );
}
