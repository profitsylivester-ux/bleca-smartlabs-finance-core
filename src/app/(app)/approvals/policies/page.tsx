import type { Metadata } from 'next';
import Link from 'next/link';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { prisma } from '@/lib/db/prisma';
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, PageHeader, Select, SelectOption, Label } from '@/components/ui';
import { PolicyEditor } from './PolicyEditor';

export const metadata: Metadata = { title: 'Approval policies' };

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

export default async function ApprovalPoliciesPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string;
    pageSize?: string;
    entityType?: string;
    isActive?: string;
    edit?: string;
  }>;
}) {
  const ctx = await requireContext();
  await authorize(ctx, { module: 'APPROVALS', action: 'VIEW' });

  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page || '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(params.pageSize || '20', 10)));
  const entityType = params.entityType;
  const isActive = params.isActive ? params.isActive === 'true' : undefined;
  const editId = params.edit;
  const orgId = ctx.actor.organizationId!;

  const where: Record<string, unknown> = { organizationId: orgId };
  if (entityType) where.entityType = entityType;
  if (isActive !== undefined) where.isActive = isActive;

  const [policies, total] = await Promise.all([
    prisma.approvalPolicy.findMany({
      where,
      orderBy: { priority: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        steps: {
          orderBy: { stepOrder: 'asc' },
          include: { assigneeRole: true, assigneeUser: true },
        },
      },
    }),
    prisma.approvalPolicy.count({ where }),
  ]);

  const totalPages = Math.ceil(total / pageSize);

  if (editId) {
    const policy = policies.find((p) => p.id === editId) ?? (await prisma.approvalPolicy.findFirst({ where: { id: editId, organizationId: orgId }, include: { steps: { orderBy: { stepOrder: 'asc' }, include: { assigneeRole: true, assigneeUser: true } } } }));
    if (policy) {
      return <PolicyEditor policy={policy} />;
    }
  }

  const searchParamsObj = new URLSearchParams();
  if (entityType) searchParamsObj.set('entityType', entityType);
  if (params.isActive) searchParamsObj.set('isActive', params.isActive);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Approval policies"
        description="Configure approval workflows per entity type. Steps are evaluated in order; only applicable steps run."
        actions={
          <Link
            href="/approvals/policies?new=true"
            className="px-3 py-1.5 text-sm bg-navy-800 text-white rounded-md hover:bg-navy-700"
          >
            Create policy
          </Link>
        }
      />

      <Card>
        <CardHeader title="Filters" />
        <CardBody className="space-y-4">
          <form method="GET" className="flex flex-wrap gap-4 items-end">
            <div className="flex-1 min-w-[250px]">
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
            <div className="flex-1 min-w-[150px]">
              <Label htmlFor="isActive">Status</Label>
              <Select id="isActive" name="isActive" defaultValue={params.isActive || ''}>
                <SelectOption value="">All</SelectOption>
                <SelectOption value="true">Active</SelectOption>
                <SelectOption value="false">Inactive</SelectOption>
              </Select>
            </div>
            <Button type="submit" size="sm">Apply</Button>
            <Link href="/approvals/policies" className="text-sm text-navy-600 hover:text-navy-800 underline underline-offset-2">Clear</Link>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`Policies (${total})`} />
        <CardBody className="px-0 py-0">
          {policies.length === 0 ? (
            <EmptyState
              title="No approval policies"
              body="Create a policy to define how approval requests are routed for each entity type."
            />
          ) : (
            <ul className="divide-border-subtle divide-y">
              {policies.map((policy) => (
                <li key={policy.id} className="px-5 py-4 hover:bg-surface-muted transition-colors">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3 flex-wrap">
                        <span className="font-medium truncate">{policy.name}</span>
                        <Badge tone={policy.isActive ? 'success' : 'neutral'}>{policy.isActive ? 'Active' : 'Inactive'}</Badge>
                        <Badge tone="neutral" className="text-xs">{policy.entityType}</Badge>
                        <Badge tone="info" className="text-xs">Priority {policy.priority}</Badge>
                        <span className="text-muted-foreground text-xs">
                          {policy.steps.length} step{policy.steps.length !== 1 ? 's' : ''}
                        </span>
                      </div>
                      {policy.description && (
                        <p className="text-muted-foreground text-xs mt-1 truncate max-w-2xl">{policy.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Link
                        href={`/approvals/policies?${searchParamsObj.toString()}&edit=${policy.id}`}
                        className="px-3 py-1.5 text-sm border-border-strong border rounded-md hover:bg-surface-muted"
                      >
                        Edit
                      </Link>
                      <form action={deletePolicyAction} className="inline">
                        <input type="hidden" name="policyId" value={policy.id} />
                        <Button type="submit" variant="ghost" size="sm" className="text-negative hover:bg-red-50">
                          Delete
                        </Button>
                      </form>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1 text-xs">
                    {policy.steps.slice(0, 3).map((step) => (
                      <Badge key={step.id} tone="neutral" className="text-[10px]">
                        {step.stepOrder}. {step.name} ({step.type})
                      </Badge>
                    ))}
                    {policy.steps.length > 3 && (
                      <Badge tone="neutral" className="text-[10px]">+{policy.steps.length - 3} more</Badge>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {totalPages > 1 && (
        <nav className="flex items-center justify-center gap-2" aria-label="Pagination">
          {page > 1 && (
            <a
              href={`/approvals/policies?${searchParamsObj.toString()}&page=${page - 1}`}
              className="px-3 py-1.5 text-sm border-border-strong border rounded-md hover:bg-surface-muted"
            >
              Previous
            </a>
          )}
          <span className="px-3 py-1.5 text-sm text-muted-foreground">Page {page} of {totalPages}</span>
          {page < totalPages && (
            <a
              href={`/approvals/policies?${searchParamsObj.toString()}&page=${page + 1}`}
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

async function deletePolicyAction(formData: FormData) {
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
  await authorize(ctx, { module: 'APPROVALS', action: 'CONFIGURE' });

  const policyId = String(formData.get('policyId') ?? '');
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
      const orgId = ctx.actor.organizationId!;
      const existingPolicy = await tx.approvalPolicy.findFirst({
        where: { id: policyId, organizationId: orgId },
      });

      if (!existingPolicy) throw new Error('Policy not found');

      const inFlightRequests = await tx.approvalRequest.count({
        where: { policyId, status: { in: ['PENDING', 'IN_PROGRESS'] } },
      });

      if (inFlightRequests > 0) {
        throw new Error(`Cannot delete policy with ${inFlightRequests} in-flight requests`);
      }

      await tx.approvalPolicyStep.deleteMany({ where: { policyId } });
      await tx.approvalPolicy.delete({ where: { id: policyId } });

      await writeAuditEntry(
        tx,
        { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
        {
          action: 'APPROVAL_POLICY_DELETED',
          entityType: 'APPROVAL_POLICY',
          entityId: policyId,
          entityLabel: existingPolicy.name,
          description: `Approval policy "${existingPolicy.name}" deleted`,
          result: 'SUCCESS',
          channel: 'WEB',
        },
        { organizationId: orgId, requestId: m.requestId },
      );
    },
  );

  revalidatePath('/approvals/policies');
}