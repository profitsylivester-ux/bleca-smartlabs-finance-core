import type { Metadata } from 'next';
import { AuthFooterLink, AuthShell } from '@/modules/auth/components/auth-shell';
import { ForgotPasswordForm } from '@/modules/auth/components/password-forms';

export const metadata: Metadata = { title: 'Reset your password' };

export default function ForgotPasswordPage() {
  return (
    <AuthShell
      title="Reset your password"
      description="We will email you a link"
      footer={<AuthFooterLink href="/login">Back to sign in</AuthFooterLink>}
    >
      <ForgotPasswordForm />
    </AuthShell>
  );
}
