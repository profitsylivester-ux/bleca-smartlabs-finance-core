'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Alert, Button, Input, Label } from '@/components/ui';
import {
  assignRoleAction,
  createUserAction,
  type ActionResult,
} from '@/modules/users-roles/server/actions';
import {
  createDelegationAction,
  decideReviewItemAction,
  revokeSessionAction,
} from '@/modules/users-roles/server/governance-actions';

/**
 * A reusable submit button that reflects the form's pending state.
 *
 * Using useFormStatus here rather than local state means the button cannot claim
 * to be working when it is not, which matters for actions like "grant
 * permissions" where a double click would be two grants.
 */
function Submit({ children, pendingLabel }: { children: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? pendingLabel : children}
    </Button>
  );
}

export function ActionFeedback({ state }: { state: ActionResult | null }) {
  if (!state?.message) return null;
  return (
    <div className="mt-3">
      <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
    </div>
  );
}

const selectClass = 'h-9 w-full rounded-md border border-border-strong bg-white px-3 text-sm';

export function CreateUserForm({ roles }: { roles: Array<{ code: string; name: string }> }) {
  const [state, action] = useActionState(createUserAction, null);

  return (
    <form action={action} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="email">Email address</Label>
          <Input id="email" name="email" type="email" required />
        </div>
        <div>
          <Label htmlFor="fullName">Full name</Label>
          <Input id="fullName" name="fullName" required />
        </div>
        <div>
          <Label htmlFor="jobTitle">Job title</Label>
          <Input id="jobTitle" name="jobTitle" />
        </div>
        <div>
          <Label htmlFor="roleCode">Role</Label>
          <select id="roleCode" name="roleCode" required className={selectClass}>
            {roles.map((role) => (
              <option key={role.code} value={role.code}>
                {role.name}
              </option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="temporary"
              className="border-border-strong mt-0.5 h-4 w-4 rounded"
            />
            <span>
              Temporary access
              <span className="text-muted-foreground block text-xs">
                Requires an expiry date. Access that never expires is permanent access.
              </span>
            </span>
          </label>
        </div>
        <div>
          <Label htmlFor="expiresAt">Expires at</Label>
          <Input id="expiresAt" name="expiresAt" type="date" />
        </div>
      </div>
      <Submit pendingLabel="Creating...">Create account</Submit>
      <ActionFeedback state={state} />
    </form>
  );
}

export function AssignRoleForm({
  users,
  roles,
}: {
  users: Array<{ id: string; emailNormalized: string }>;
  roles: Array<{ code: string }>;
}) {
  const [state, action] = useActionState(assignRoleAction, null);

  return (
    <form action={action} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <Label htmlFor="assignUser">User</Label>
          <select id="assignUser" name="userId" required className={selectClass}>
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.emailNormalized}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="assignRole">Role</Label>
          <select id="assignRole" name="roleCode" required className={selectClass}>
            {roles.map((role) => (
              <option key={role.code} value={role.code}>
                {role.code}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="assignAction">Action</Label>
          <select id="assignAction" name="action" className={selectClass}>
            <option value="grant">Grant</option>
            <option value="revoke">Revoke</option>
          </select>
        </div>
      </div>
      <div>
        <Label htmlFor="assignReason">Reason</Label>
        <Input
          id="assignReason"
          name="reason"
          required
          placeholder="Recorded permanently in the audit trail"
        />
      </div>
      <p className="text-muted-foreground text-xs">
        Granting or revoking a role requires you to re-enter your password. The affected
        account&apos;s sessions end immediately afterwards.
      </p>
      <Submit pendingLabel="Applying...">Apply</Submit>
      <ActionFeedback state={state} />
    </form>
  );
}

export function CreateDelegationForm({
  users,
  roles,
}: {
  users: Array<{ id: string; emailNormalized: string }>;
  roles: Array<{ id: string; code: string }>;
}) {
  const [state, action] = useActionState(createDelegationAction, null);

  return (
    <form action={action} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="granteeId">Delegate to</Label>
          <select id="granteeId" name="granteeId" required className={selectClass}>
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.emailNormalized}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="delegationRole">Role delegated</Label>
          <select id="delegationRole" name="roleId" required className={selectClass}>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.code}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="kind">Kind</Label>
          <select id="kind" name="kind" className={selectClass}>
            <option value="APPROVAL_AUTHORITY">Approval authority</option>
            <option value="TEMPORARY_ACCESS">Temporary access</option>
            <option value="ACTING_CAPACITY">Acting capacity</option>
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="startsAt">From</Label>
            <Input id="startsAt" name="startsAt" type="date" required />
          </div>
          <div>
            <Label htmlFor="expiresAt">Until</Label>
            <Input id="expiresAt" name="expiresAt" type="date" required />
          </div>
        </div>
      </div>
      <div>
        <Label htmlFor="delegationReason">Reason</Label>
        <Input id="delegationReason" name="reason" required />
      </div>
      <p className="text-muted-foreground text-xs">
        Maximum 90 days. You cannot delegate to yourself: a delegation exists so authority can move
        to someone else, and self-delegation would defeat the purpose.
      </p>
      <Submit pendingLabel="Delegating...">Create delegation</Submit>
      <ActionFeedback state={state} />
    </form>
  );
}

export function DecideReviewItemForm({ itemId }: { itemId: string }) {
  const [state, action] = useActionState(decideReviewItemAction, null);

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="itemId" value={itemId} />
      <div className="w-32">
        <Label htmlFor={`decision-${itemId}`}>Decision</Label>
        <select
          id={`decision-${itemId}`}
          name="decision"
          className="border-border-strong h-8 w-full rounded-md border bg-white px-2 text-xs"
        >
          <option value="RETAIN">Retain</option>
          <option value="REVOKE">Revoke</option>
          <option value="MODIFY">Modify</option>
        </select>
      </div>
      <div className="min-w-40 flex-1">
        <Label htmlFor={`reason-${itemId}`}>Reason</Label>
        <Input id={`reason-${itemId}`} name="decisionReason" required className="h-8 text-xs" />
      </div>
      <Submit pendingLabel="Saving...">Record</Submit>
      <ActionFeedback state={state} />
    </form>
  );
}

export function RevokeSessionButton({ sessionId, email }: { sessionId: string; email: string }) {
  const [pending, setPending] = useState(false);

  return (
    <form
      action={async (formData: FormData) => {
        setPending(true);
        await revokeSessionAction({
          sessionId,
          reason: String(formData.get('reason') ?? `Session revoked for ${email}`),
        });
        setPending(false);
      }}
    >
      <Input
        name="reason"
        className="mb-2 h-7 text-xs"
        placeholder={`Reason for revoking ${email}`}
        defaultValue={`Session revoked by administrator`}
      />
      <Button type="submit" variant="danger" size="sm" disabled={pending}>
        {pending ? 'Revoking...' : 'Revoke'}
      </Button>
    </form>
  );
}
