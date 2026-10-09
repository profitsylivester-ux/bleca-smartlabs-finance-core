'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, Input, Label } from '@/components/ui';
import { AuthErrorBanner } from '@/modules/auth/components/auth-shell';
import { loginAction, type ActionResult } from '@/modules/auth/server/actions';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" className="w-full" disabled={pending}>
      {pending ? 'Checking...' : 'Sign in'}
    </Button>
  );
}

export function LoginForm() {
  const [state, action] = useActionState<ActionResult | null, FormData>(loginAction, null);

  return (
    <form action={action} noValidate>
      <AuthErrorBanner message={state?.message} />

      <div className="space-y-4">
        <div>
          <Label htmlFor="email">Email address</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            autoFocus
            placeholder="you@blecasmartlabs.co.tz"
          />
        </div>

        <div>
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>

        <SubmitButton />
      </div>
    </form>
  );
}
