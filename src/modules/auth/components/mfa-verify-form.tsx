'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, Input, Label } from '@/components/ui';
import { AuthErrorBanner } from '@/modules/auth/components/auth-shell';
import { mfaVerifyAction, type ActionResult } from '@/modules/auth/server/actions';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" className="w-full" disabled={pending}>
      {pending ? 'Verifying...' : 'Verify'}
    </Button>
  );
}

export function MfaVerifyForm() {
  const [state, action] = useActionState<ActionResult | null, FormData>(mfaVerifyAction, null);

  return (
    <form action={action} noValidate>
      <AuthErrorBanner message={state?.message} />

      <div className="space-y-4">
        <div>
          <Label htmlFor="code">Authentication code</Label>
          <Input
            id="code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={12}
            required
            autoFocus
            placeholder="000000"
            className="mono h-12 text-center text-xl tracking-[0.4em]"
          />
          <p className="text-muted-foreground mt-1.5 text-xs">
            Six digits from your authenticator app, or a recovery code if you have lost it.
          </p>
        </div>

        <SubmitButton />
      </div>
    </form>
  );
}
