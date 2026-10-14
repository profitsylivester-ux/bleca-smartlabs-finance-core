import type { Metadata } from 'next';
import Link from 'next/link';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { prisma } from '@/lib/db/prisma';
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, PageHeader, Select, SelectOption } from '@/components/ui';
import { formatDateTime, formatRelative } from '@/lib/format';
import MasterDataChangeList from './MasterDataChangeList';

export const metadata: Metadata = { title: 'Approvals' };

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string;
    pageSize?: string;
    status?: string;
    entityType?: string;
    submittedByMe?: string;
    assignedToMe?: string;
  }>;
}) {
  const ctx = await requireContext();
  await authorize(ctx, { module: 'APPROVALS', action: 'VIEW' });

  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page || '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(params.pageSize || '20', 10)));
  const status = params.status;
  const entityType = params.entityType;
  const submittedByMe = params.submittedByMe === 'true';
  const assignedToMe = params.assignedToMe === 'true';

  const orgId = ctx.actor.organizationId!;
  const where: Record<string, unknown> = { organizationId: orgId };
  if (status) where.status = status;
  if (entityType) where.entityType = entityType;
  if (submittedByMe) where.submittedById = ctx.actor.userId;

  let requests;
  let total;

  if (assignedToMe) {
    const stepInstances = await prisma.approvalStepInstance.findMany({
      where: {
        request: { organizationId: orgId },
        OR: [
          { assigneeUserId: ctx.actor.userId },
          {
            assigneeRole: {
              userRoles: {
                some: { userId: ctx.actor.userId, revokedAt: null },
              },
            },
          },
        ],
        status: 'PENDING',
      },
      include: { request: true },
      distinct: ['requestId'],
    });

    const requestIds = stepInstances.map((si) => si.requestId);
    where.id = { in: requestIds };

    [requests, total] = await Promise.all([
      prisma.approvalRequest.findMany({
        where,
        orderBy: { submittedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          stepInstances: { orderBy: { stepOrder: 'asc' } },
          policy: true,
          submittedBy: { select: { fullName: true, emailNormalized: true } },
        },
      }),
      prisma.approvalRequest.count({ where }),
    ]);
  } else {
    [requests, total] = await Promise.all([
      prisma.approvalRequest.findMany({
        where,
        orderBy: { submittedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          stepInstances: { orderBy: { stepOrder: 'asc' } },
          policy: true,
          submittedBy: { select: { fullName: true, emailNormalized: true } },
        },
      }),
      prisma.approvalRequest.count({ where }),
    ]);
  }

  const masterDataChanges = await prisma.masterDataChangeRequest.findMany({
    where: { organizationId: orgId, status: 'PENDING_APPROVAL' },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, entityType: true, entityId: true, reason: true, createdAt: true },
  });

  const totalPages = Math.ceil(total / pageSize);

  const statusTone: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
    PENDING: 'info',
    IN_PROGRESS: 'info',
    APPROVED: 'success',
    REJECTED: 'danger',
    CANCELLED: 'warning',
    EXPIRED: 'neutral',
    SUPERSEDED: 'neutral',
  };

  const entityTypeOptions = [
    'TRANSACTION',
    'JOURNAL_ENTRY',
    'INVOICE',
    'PAYMENT',
    'RECEIPT',
    'QUOTATION',
    'CREDIT_NOTE',
    'DEBIT_NOTE',
    'REFUND',
    'BUDGET',
    'BUDGET_REVISION',
    'BUDGET_TRANSFER',
    'COMMITMENT',
    'PERIOD_REOPEN',
    'FINANCIAL_CLOSE',
    'ADJUSTMENT',
    'REVERSAL',
    'MASTER_DATA_CHANGE',
    'SUPPLIER_BANK_DETAIL_CHANGE',
    'CUSTOMER_CREDIT_LIMIT',
    'DOCUMENT',
    'IMPORT_BATCH',
    'RECONCILIATION',
    'RECONCILIATION_ADJUSTMENT',
    'TAX_FILING',
  ];

  const statusOptions = ['PENDING', 'IN_PROGRESS', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'SUPERSEDED'];

  const searchParamsObj = new URLSearchParams();
  if (params.status) searchParamsObj.set('status', params.status);
  if (params.entityType) searchParamsObj.set('entityType', params.entityType);
  if (params.submittedByMe) searchParamsObj.set('submittedByMe', params.submittedByMe);
  if (params.assignedToMe) searchParamsObj.set('assignedToMe', params.assignedToMe);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Approvals"
        description="Inbox of approval requests. Filter by status, entity type, or your involvement."
      />

      <Card>
        <CardHeader title="Filters" />
        <CardBody className="space-y-4">
          <form method="GET" className="flex flex-wrap gap-4 items-end">
            <div className="flex-1 min-w-[200px]">
              <Label htmlFor="status">Status</Label>
              <Select id="status" name="status" defaultValue={params.status || ''}>
                <SelectOption value="">All statuses</SelectOption>
                {statusOptions.map((s) => (
                  <SelectOption key={s} value={s}>
                    {s.replace(/_/g, ' ')}
                  </SelectOption>
                ))}
              </Select>
            </div>
            <div className="flex-1 min-w-[200px]">
              <Label htmlFor="entityType">Entity type</Label>
              <Select id="entityType" name="entityType" defaultValue={params.entityType || ''}>
                <SelectOption value="">All types</SelectOption>
                {entityTypeOptions.map((t) => (
                  <SelectOption key={t} value={t}>
                    {t.replace(/_/g, ' ')}
                  </SelectOption>
                ))}
              </Select>
            </div>
            <div className="flex gap-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  name="submittedByMe"
                  defaultChecked={submittedByMe}
                  className="border-border-strong h-4 w-4 rounded"
                />
                <span className="text-sm">Submitted by me</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  name="assignedToMe"
                  defaultChecked={assignedToMe}
                  className="border-border-strong h-4 w-4 rounded"
                />
                <span className="text-sm">Assigned to me</span>
              </label>
            </div>
            <Button type="submit" size="sm">Apply</Button>
            <Link
              href="/approvals"
              className="text-sm text-navy-600 hover:text-navy-800 underline underline-offset-2"
            >
              Clear
            </Link>
          </form>
        </CardBody>
      </Card>

      {masterDataChanges.length > 0 && (
        <Card>
          <CardHeader title="Business Setup requests" description="Pending deletions awaiting your decision" />
          <CardBody className="px-0 py-0">
            <MasterDataChangeList changes={masterDataChanges.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() }))} />
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader
          title={`Approval requests (${total})`}
          description={assignedToMe ? 'Showing only requests awaiting your decision' : undefined}
        />
        <CardBody className="px-0 py-0">
          {requests.length === 0 ? (
            <EmptyState
              title={assignedToMe ? 'Nothing awaiting your decision' : 'No approval requests'}
              body={assignedToMe
                ? 'When something needs your approval, it will appear here.'
                : 'Submit a transaction, journal entry, or other item to create an approval request.'}
            />
          ) : (
            <ul className="divide-border-subtle divide-y">
              {requests.map((request) => {
                const currentStep = request.stepInstances[request.currentStepIndex];
                const currentStepName = currentStep?.stepName ?? 'Unknown step';
                const currentStepStatus = currentStep?.status ?? 'PENDING';

                return (
                  <li key={request.id} className="px-5 py-3 hover:bg-surface-muted transition-colors">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium mono text-sm">{request.entityType}</span>
                        <span className="text-muted-foreground mono text-xs">#{request.entityId.slice(0, 8)}</span>
                        <Badge tone={statusTone[request.status] ?? 'neutral'}>{request.status}</Badge>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span>Submitted by {request.submittedBy.fullName}</span>
                        <span>at {formatDateTime(request.submittedAt)}</span>
                        <span>({formatRelative(request.submittedAt)})</span>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                      <span className="text-muted-foreground">Current step:</span>
                      <span className="font-medium">{currentStepName}</span>
                      <Badge
                        tone={statusTone[currentStepStatus] ?? 'neutral'}
                        className="ml-1"
                      >
                        {currentStepStatus}
                      </Badge>
                      {currentStep?.assigneeUserId && (
                        <>
                          <span className="text-muted-foreground">Assigned to:</span>
                          <span className="font-medium">{currentStep.assigneeUserId}</span>
                        </>
                      )}
                      <a
                        href={`/approvals/${request.id}`}
                        className="ml-auto text-navy-600 hover:text-navy-800 underline underline-offset-2 text-sm"
                      >
                        View →
                      </a>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>

      {totalPages > 1 && (
        <nav className="flex items-center justify-center gap-2" aria-label="Pagination">
          {page > 1 && (
            <a
              href={`/approvals?${searchParamsObj.toString()}&page=${page - 1}`}
              className="px-3 py-1.5 text-sm border-border-strong border rounded-md hover:bg-surface-muted"
            >
              Previous
            </a>
          )}
          <span className="px-3 py-1.5 text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          {page < totalPages && (
            <a
              href={`/approvals?${searchParamsObj.toString()}&page=${page + 1}`}
              className="px-3 py-1.5 text-sm border-border-strong border rounded-md hover:bg-surface-muted"
            >
              Next
            </a>
          )}
        </nav>
      )}
    </div>
  );
}

function Label({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-muted-foreground mb-1.5 block text-xs font-medium">
      {children}
    </label>
  );
}