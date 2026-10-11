import { Card, CardHeader, CardBody, Badge, EmptyState } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import type { ApprovalRequest } from '@/lib/approvals';

interface PolicyHistoryProps {
  request: ApprovalRequest & {
    policySnapshot: unknown;
    policy: { name: string } | null;
  };
}

export function PolicyHistory({ request }: PolicyHistoryProps) {
  const snapshot = request.policySnapshot as
    | {
        policyId: string;
        policyName: string;
        entityType: string;
        steps: Array<{
          stepOrder: number;
          name: string;
          type: string;
          assigneeType: string;
          assigneeRoleId: string | null;
          assigneeUserId: string | null;
          resolutionMode: string;
          quorum: number | null;
          conditionOperator: string | null;
          conditionValue: unknown;
          isRequired: boolean;
          isFinalApprover: boolean;
        }>;
        createdAt: Date;
      }
    | null;

  if (!snapshot || snapshot.steps.length === 0) {
    return (
      <Card>
        <CardHeader title="Policy snapshot" />
        <CardBody>
          <EmptyState title="No policy snapshot" body="This request has no policy steps recorded." />
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Policy snapshot"
        description={snapshot.policyName}
        actions={<span className="text-xs text-muted-foreground">Captured at submission</span>}
      />
      <CardBody className="px-0 py-0">
        <ul className="divide-border-subtle divide-y">
          {snapshot.steps.map((step) => (
            <li key={step.stepOrder} className="px-5 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-medium">Step {step.stepOrder}: {step.name}</span>
                  <Badge tone="neutral" className="ml-2 text-xs">
                    {step.type}
                  </Badge>
                  {step.isFinalApprover && <Badge tone="warning" className="ml-1 text-xs">Final</Badge>}
                  {step.isRequired ? null : <Badge tone="info" className="ml-1 text-xs">Optional</Badge>}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>Assignee: {step.assigneeType}</span>
                  {step.assigneeRoleId && <span>Role: {step.assigneeRoleId.slice(0, 8)}</span>}
                  {step.assigneeUserId && <span>User: {step.assigneeUserId.slice(0, 8)}</span>}
                  <span>Resolution: {step.resolutionMode}</span>
                </div>
              </div>
              {step.conditionOperator && step.conditionOperator !== 'ALWAYS' && (
                <p className="mt-1 text-xs text-muted-foreground font-mono">
                  Condition: {step.conditionOperator}{' '}
                  {step.conditionValue
                    ? typeof step.conditionValue === 'object'
                      ? JSON.stringify(step.conditionValue)
                      : String(step.conditionValue)
                    : 'none'}
                </p>
              )}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}