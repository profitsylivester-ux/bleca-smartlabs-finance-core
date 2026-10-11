'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Button, Input, Label, Alert } from '@/components/ui';
import { decideApprovalAction } from './actions';

interface DecisionFormProps {
  requestId: string;
  stepInstanceId: string;
  stepName: string;
  isFinalApprover: boolean;
  sodViolations: boolean;
}

function SubmitButton({ children, pendingLabel }: { children: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? pendingLabel : children}
    </Button>
  );
}

function ActionFeedback({ state }: { state: { ok: boolean; message?: string } | null }) {
  if (!state?.message) return null;
  return (
    <div className="mt-3">
      <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
    </div>
  );
}

export function DecisionForm({
  requestId,
  stepInstanceId,
  stepName,
  isFinalApprover,
  sodViolations,
}: DecisionFormProps) {
  const [state, action] = useActionState(decideApprovalAction, null);
  const router = useRouter();

  return (
    <form action={action} className="space-y-3 border-t border-border-subtle pt-4">
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="stepInstanceId" value={stepInstanceId} />

      <div>
        <Label htmlFor="decision">Decision for &ldquo;{stepName}&rdquo;</Label>
        <select
          id="decision"
          name="decision"
          required
          className="border-border-strong h-9 w-full rounded-md border bg-white px-3 text-sm"
        >
          <option value="APPROVED">Approve</option>
          <option value="REJECTED">Reject</option>
          <option value="DEFERRED">Defer</option>
          <option value="RETURNED_FOR_CHANGES">Return for changes</option>
        </select>
      </div>

      <div>
        <Label htmlFor="reason">Reason (required for reject/defer/return)</Label>
        <Input
          id="reason"
          name="reason"
          placeholder="Explain your decision..."
          className="h-9 text-sm"
        />
      </div>

      {sodViolations && (
        <Alert tone="warning" title="Segregation of duties violation detected">
          This step involves a segregation-of-duties concern. Your decision will be recorded with
          SOD evidence. If you are the submitter, you cannot approve your own request without a
          CEO-granted waiver.
        </Alert>
      )}

      {isFinalApprover && (
        <Alert tone="info" title="Final approval step">
          This is the final approval step. Approving here will complete the request and allow
          posting.
        </Alert>
      )}

      <div className="flex flex-wrap gap-2">
        <SubmitButton pendingLabel="Deciding...">Record decision</SubmitButton>
        <Button type="button" variant="outline" size="sm" onClick={() => router.refresh()}>
          Refresh
        </Button>
      </div>

      <ActionFeedback state={state} />
    </form>
  );
}