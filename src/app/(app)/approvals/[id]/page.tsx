import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { prisma } from '@/lib/db/prisma';
import { PageHeader, Card, CardHeader, CardBody, Badge, Button, Alert, EmptyState } from '@/components/ui';
import { formatDateTime, formatRelative } from '@/lib/format';
import { DecisionForm } from './DecisionForm';
import { PolicyHistory } from './PolicyHistory';
import { Prisma } from '@/generated/prisma/client';

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  return { title: `Approval ${id.slice(0, 8)}` };
}

const approvalRequestInclude = {
  policy: true,
  stepInstances: {
    orderBy: { stepOrder: 'asc' as const },
    include: {
      decisions: {
        orderBy: { createdAt: 'asc' as const },
        include: { actor: { select: { fullName: true, emailNormalized: true } } },
      },
      assigneeUser: { select: { fullName: true, emailNormalized: true } },
      assigneeRole: { select: { code: true, name: true, isFinalApprover: true } },
    },
  },
  decisionRecords: {
    orderBy: { createdAt: 'asc' as const },
    include: { actor: { select: { fullName: true, emailNormalized: true } } },
  },
  submittedBy: { select: { fullName: true, emailNormalized: true } },
  decidedBy: { select: { fullName: true, emailNormalized: true } },
  sodWaivers: {
    include: {
      user: { select: { fullName: true, emailNormalized: true } },
      recordedBy: { select: { fullName: true, emailNormalized: true } },
      reviewedBy: { select: { fullName: true, emailNormalized: true } },
    },
  },
} satisfies Prisma.ApprovalRequestInclude;

type ApprovalRequestWithRelations = Prisma.ApprovalRequestGetPayload<{ include: typeof approvalRequestInclude }>;

export default async function ApprovalDetailPage({ params }: PageProps) {
  const ctx = await requireContext();
  const { id } = await params;
  const orgId = ctx.actor.organizationId!;

  await authorize(ctx, { module: 'APPROVALS', action: 'VIEW' });

  const request = await prisma.approvalRequest.findFirst({
    where: { id, organizationId: orgId },
    include: approvalRequestInclude,
  }) as ApprovalRequestWithRelations | null;

  if (!request) {
    notFound();
  }

  const policySnapshot = request.policySnapshot as unknown as {
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
  };

  const canDecide = request.stepInstances.some(
    (si) =>
      si.status === 'PENDING' &&
      (si.assigneeUserId === ctx.actor.userId ||
        (si.assigneeRoleId &&
          ctx.actor.roleCodes.some((rc) => rc === si.assigneeRole?.code))) &&
      ['APPROVE', 'REJECT'].includes(request.status === 'IN_PROGRESS' ? 'APPROVE' : 'REJECT')
  );

  const isSubmitter = request.submittedById === ctx.actor.userId;
  const isFinalApprover = ctx.actor.roleCodes.includes('CEO');
  const currentStep = request.stepInstances[request.currentStepIndex];
  const isCurrentAssignee =
    currentStep &&
    (currentStep.assigneeUserId === ctx.actor.userId ||
      (currentStep.assigneeRoleId &&
        ctx.actor.roleCodes.some((rc) => rc === currentStep.assigneeRole?.code)));

  const statusTone: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
    PENDING: 'info',
    IN_PROGRESS: 'info',
    APPROVED: 'success',
    REJECTED: 'danger',
    CANCELLED: 'warning',
    EXPIRED: 'neutral',
    SUPERSEDED: 'neutral',
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Approval request`}
        description={`${request.entityType} ${request.entityId} • ${request.policy?.name ?? 'Unknown policy'}`}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={statusTone[request.status] ?? 'neutral'} className="text-sm">
              {request.status}
            </Badge>
            {request.sodWaivers.length > 0 && (
              <Badge tone="warning">SOD waiver(s): {request.sodWaivers.length}</Badge>
            )}
          </div>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader title="Timeline" description="Every step and decision in sequence" />
            <CardBody className="px-0 py-0">
              {request.stepInstances.length === 0 ? (
                <EmptyState title="No steps" body="This request has no step instances." />
              ) : (
                <ul className="divide-border-subtle divide-y">
                  {request.stepInstances.map((step, index) => {
                    const isCompleted = step.status !== 'PENDING';
                    const stepTone = statusTone[step.status] ?? 'neutral';
                    const decisions = step.decisions;

                    return (
                      <li key={step.id} className="px-5 py-4 relative">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="flex items-start gap-3">
                            <div
                              className={`flex-shrink-0 w-8 h-8 rounded-full border-2 flex items-center justify-center ${
                                isCompleted
                                  ? 'border-emerald-500 bg-emerald-50'
                                  : index === request.currentStepIndex
                                  ? 'border-navy-500 bg-navy-50'
                                  : 'border-border-subtle bg-white'
                              }`}
                            >
                              {isCompleted ? (
                                <svg className="h-4 w-4 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                              ) : index === request.currentStepIndex ? (
                                <span className="text-navy-600 font-bold text-sm">{index + 1}</span>
                              ) : (
                                <span className="text-muted-foreground text-sm">{index + 1}</span>
                              )}
                            </div>
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="font-medium">{step.stepName}</span>
                                <Badge tone={stepTone} className="text-xs">
                                  {step.status}
                                </Badge>
                                {step.assigneeRole?.isFinalApprover && (
                                  <Badge tone="warning" className="text-xs">Final</Badge>
                                )}
                              </div>
                              <p className="text-muted-foreground text-xs mt-0.5">
                                Type: {step.stepType} • Assignee: {step.assigneeType}
                                {step.assigneeRole?.code ? ` (${step.assigneeRole.code})` : ''}
                                {step.assigneeUser?.fullName ? ` → ${step.assigneeUser.fullName}` : ''}
                              </p>
                              {decisions.length > 0 && (
                                <div className="mt-2 space-y-1 ml-10 border-l-2 border-border-subtle pl-3">
                                  {decisions.map((decision) => (
                                    <div key={decision.id} className="text-xs">
                                      <span className="font-medium">{decision.actor.fullName}</span>{' '}
                                      <Badge
                                        tone={
                                          decision.decision === 'APPROVED'
                                            ? 'success'
                                            : decision.decision === 'REJECTED'
                                            ? 'danger'
                                            : 'neutral'
                                        }
                                      >
                                        {decision.decision}
                                      </Badge>
                                      {decision.sodViolation && (
                                        <Badge tone="danger" className="ml-1">SOD violation</Badge>
                                      )}
                                      {decision.sodWaiverId && (
                                        <Badge tone="warning" className="ml-1">Waived</Badge>
                                      )}
                                      {decision.delegationId && (
                                        <Badge tone="info" className="ml-1">Delegated</Badge>
                                      )}
                                      {decision.reason && (
                                        <span className="text-muted-foreground ml-2">— {decision.reason}</span>
                                      )}
                                      <span className="text-muted-foreground ml-2">
                                        {formatDateTime(decision.createdAt)} ({formatRelative(decision.createdAt)})
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="text-right text-xs text-muted-foreground shrink-0">
                            {step.decidedAt ? (
                              <>
                                Decided {formatDateTime(step.decidedAt)}<br />
                                ({formatRelative(step.decidedAt)})
                              </>
                            ) : (
                              'Pending'
                            )}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardBody>
          </Card>

          <PolicyHistory request={request} />
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Details" />
            <CardBody className="space-y-3">
              <dl className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Entity</dt>
                  <dd className="font-mono font-medium">{request.entityType} {request.entityId.slice(0, 12)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Policy</dt>
                  <dd className="font-medium">{request.policy?.name ?? 'Unknown'}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Submitted by</dt>
                  <dd>{request.submittedBy.fullName} ({request.submittedBy.emailNormalized})</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Submitted at</dt>
                  <dd>
                    {formatDateTime(request.submittedAt)} ({formatRelative(request.submittedAt)})
                  </dd>
                </div>
                {request.decidedAt && (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Decided at</dt>
                    <dd>
                      {formatDateTime(request.decidedAt)} ({formatRelative(request.decidedAt)})
                    </dd>
                  </div>
                )}
                {request.decidedBy && (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Decided by</dt>
                    <dd>{request.decidedBy.fullName}</dd>
                  </div>
                )}
              </dl>
            </CardBody>
          </Card>

          {request.sodWaivers.length > 0 && (
            <Card>
              <CardHeader title="Segregation of Duties Waivers" />
              <CardBody className="space-y-3">
                {request.sodWaivers.map((waiver) => (
                  <div key={waiver.id} className="border-border-subtle border rounded p-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium">
                          {waiver.user.fullName} ({waiver.user.emailNormalized})
                        </p>
                        <p className="text-sm text-muted-foreground">{waiver.reason}</p>
                      </div>
                      <Badge
                        tone={
                          waiver.status === 'GRANTED'
                            ? 'success'
                            : waiver.status === 'REJECTED'
                            ? 'danger'
                            : 'warning'
                        }
                      >
                        {waiver.status}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Recorded by {waiver.recordedBy.fullName} at {formatDateTime(waiver.recordedAt)}
                      {waiver.reviewedAt
                        ? ` • Reviewed by ${waiver.reviewedBy?.fullName ?? 'unknown'} at ${formatDateTime(waiver.reviewedAt)}`
                        : ''}
                    </p>
                  </div>
                ))}
              </CardBody>
            </Card>
          )}

          {currentStep &&
            currentStep.status === 'PENDING' &&
            isCurrentAssignee &&
            ['IN_PROGRESS', 'PENDING'].includes(request.status) && (
              <DecisionForm
                requestId={request.id}
                stepInstanceId={currentStep.id}
                stepName={currentStep.stepName}
                isFinalApprover={currentStep.assigneeRole?.isFinalApprover ?? false}
                sodViolations={currentStep.decisions.filter((d) => d.sodViolation).length > 0}
              />
            )}

          {request.status === 'IN_PROGRESS' && isSubmitter && !isCurrentAssignee && (
            <Card>
              <CardHeader title="Actions" />
              <CardBody>
                <form action={cancelApprovalAction} className="space-y-2">
                  <input type="hidden" name="requestId" value={request.id} />
                  <p className="text-sm text-muted-foreground">
                    You can cancel this request while it is still in progress.
                  </p>
                  <Button type="submit" variant="outline" size="sm">
                    Cancel request
                  </Button>
                </form>
              </CardBody>
            </Card>
          )}

          {['APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED'].includes(request.status) && (
            <Alert tone={request.status === 'APPROVED' ? 'success' : 'warning'}>
              This request is <strong>{request.status.toLowerCase()}</strong> and no further
              actions can be taken.
            </Alert>
          )}
        </div>
      </div>
    </div>
  );
}

async function cancelApprovalAction(formData: FormData) {
  'use server';

  const { requireContext } = await import('@/lib/auth/guard');
  const { authorize } = await import('@/lib/kernel/authorize');
  const { prisma } = await import('@/lib/db/prisma');
  const { writeAuditEntry } = await import('@/lib/audit/writer');
  const { withAudit } = await import('@/lib/db/with-audit');
  const { headers } = await import('next/headers');
  const { randomUUID } = await import('node:crypto');
  const { revalidatePath } = await import('next/cache');

  const ctx = await requireContext();
  await authorize(ctx, { module: 'APPROVALS', action: 'SUBMIT' });

  const requestId = String(formData.get('requestId') ?? '');
  const m = await (async () => {
    const h = await headers();
    return {
      ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
      userAgent: h.get('user-agent'),
      requestId: h.get('x-request-id') ?? randomUUID(),
    };
  })();

  await withAudit(
    {
      organizationId: ctx.actor.organizationId,
      actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
      ipAddress: m.ipAddress,
      userAgent: m.userAgent,
      requestId: m.requestId,
      sessionId: ctx.actor.sessionId,
    },
    async (tx) => {
      const request = await tx.approvalRequest.findUnique({
        where: { id: requestId },
        include: { stepInstances: true },
      });

      if (!request) throw new Error('Request not found');
      if (['APPROVED', 'REJECTED', 'CANCELLED'].includes(request.status)) {
        throw new Error(`Cannot cancel request in ${request.status} status`);
      }
      if (request.submittedById !== ctx.actor.userId && !ctx.actor.roleCodes.includes('CEO')) {
        throw new Error('Only the submitter or CEO can cancel this request');
      }

      await tx.approvalRequest.update({
        where: { id: requestId },
        data: { status: 'CANCELLED', decidedAt: new Date(), decidedById: ctx.actor.userId },
      });

      await tx.approvalStepInstance.updateMany({
        where: { requestId, status: 'PENDING' },
        data: { status: 'CANCELLED', decidedAt: new Date(), decidedById: ctx.actor.userId },
      });

      await writeAuditEntry(
        tx,
        { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
        {
          action: 'APPROVAL_REQUEST_CANCELLED',
          entityType: 'APPROVAL_REQUEST',
          entityId: requestId,
          entityLabel: requestId,
          description: `Approval request ${requestId} cancelled`,
          changes: { status: { from: request.status, to: 'CANCELLED' } },
          result: 'SUCCESS',
          channel: 'WEB',
        },
        { organizationId: ctx.actor.organizationId, requestId: m.requestId },
      );
    },
  );

  revalidatePath(`/approvals/${requestId}`);
  revalidatePath('/approvals');
}