'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, Input, Label } from '@/components/ui';
import { AuthErrorBanner } from '@/modules/auth/components/auth-shell';
import {
  forgotPasswordAction,
  resetPasswordAction,
  type ActionResult,
} from '@/modules/auth/server/actions';

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" className="w-full" disabled={pending}>
      {pending ? pendingLabel : label}
    </Button>
  );
}

export function ForgotPasswordForm() {
  const [state, action] = useActionState<ActionResult | null, FormData>(forgotPasswordAction, null);

  if (state?.ok) {
    return (
      <div className="space-y-4 text-sm">
        <p className="text-foreground">{state.message}</p>
        <p className="text-muted-foreground text-xs">
          If the address is not registered, you will receive nothing. This is intentional: the form
          does not reveal which addresses have accounts.
        </p>
      </div>
    );
  }

  return (
    <form action={action} noValidate>
      <AuthErrorBanner message={state?.message} />
      <div className="space-y-4">
        <div>
          <Label htmlFor="email">Email address</Label>
          <Input id="email" name="email" type="email" autoComplete="username" required autoFocus />
        </div>
        <SubmitButton label="Send reset link" pendingLabel="Sending..." />
      </div>
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action] = useActionState<ActionResult | null, FormData>(resetPasswordAction, null);

  return (
    <form action={action} noValidate>
      <input type="hidden" name="token" value={token} />
      <AuthErrorBanner message={state?.message} />
      <div className="space-y-4">
        <div>
          <Label htmlFor="password">New password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
          />
          <p className="text-muted-foreground mt-1.5 text-xs">
            At least 12 characters, with upper and lower case, a number and a symbol.
          </p>
        </div>
        <div>
          <Label htmlFor="confirmPassword">Confirm new password</Label>
          <Input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
          />
        </div>
        <SubmitButton label="Set new password" pendingLabel="Saving..." />
      </div>
    </form>
  );
}

export function ChangePasswordForm() {
  const [state, action] = useActionState<ActionResult | null, FormData>(async (prev, formData) => {
    const { changePasswordAction } = await import('@/modules/auth/server/actions');
    return changePasswordAction(prev, formData);
  }, null);

  return (
    <form action={action} noValidate>
      <AuthErrorBanner message={state?.message} />
      <div className="space-y-4">
        <div>
          <Label htmlFor="currentPassword">Current password</Label>
          <Input
            id="currentPassword"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
            autoFocus
          />
        </div>
        <div>
          <Label htmlFor="password">New password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
          />
          <p className="text-muted-foreground mt-1.5 text-xs">
            At least 12 characters, with upper and lower case, a number and a symbol. Changing your
            password ends your other sessions.
          </p>
        </div>
        <div>
          <Label htmlFor="confirmPassword">Confirm new password</Label>
          <Input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
          />
        </div>
        <SubmitButton label="Change password" pendingLabel="Saving..." />
      </div>
    </form>
  );
}
