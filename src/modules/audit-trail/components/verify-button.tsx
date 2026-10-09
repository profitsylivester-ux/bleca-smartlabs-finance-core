'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui';
import { verifyAuditChainAction } from '@/modules/audit-trail/server/actions';

/**
 * Runs a full chain verification on demand.
 *
 * Recomputes every entry hash from its stored fields and re-derives every
 * signature. That is O(history), so it is a manual button rather than something
 * on every page render - but it must be available on demand, because "we could
 * verify it" is not the same claim as "we did".
 */
export function VerifyChainButton({ canVerify }: { canVerify: boolean }) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  if (!canVerify) {
    return (
      <p className="text-muted-foreground text-xs">Chain verification is restricted to the CEO.</p>
    );
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            const outcome = await verifyAuditChainAction();
            setResult({ ok: outcome.ok, message: outcome.message ?? 'No result returned.' });
          })
        }
      >
        {isPending ? 'Verifying...' : 'Verify chain'}
      </Button>
      {result ? (
        <p
          className={
            result.ok
              ? 'text-positive max-w-sm text-right text-xs'
              : 'text-negative max-w-sm text-right text-xs'
          }
        >
          {result.message}
        </p>
      ) : null}
    </div>
  );
}
