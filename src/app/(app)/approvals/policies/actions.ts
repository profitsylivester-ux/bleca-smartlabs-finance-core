'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { headers } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@/generated/prisma/client';

export interface ActionResult {
  ok: boolean;
  message?: string;
  data?: Record<string, unknown>;
}

const stepSchema = z.object({
  id: z.string().optional(),
  stepOrder: z.number().int().positive(),
  name: z.string().min(1).max(200),
  type: z.enum(['APPROVAL', 'REVIEW', 'NOTIFICATION', 'SIGN_OFF']),
  assigneeType: z.enum(['ROLE', 'USER', 'USER_DELEGATED', 'SPECIFIC_USER']),
  assigneeRoleId: z.string().nullable().optional(),
  assigneeUserId: z.string().nullable().optional(),
  resolutionMode: z.enum(['ANY', 'ALL', 'QUORUM']).default('ANY'),
  quorum: z.number().int().positive().nullable().optional(),
  conditionOperator: z
    .enum([
      'ALWAYS',
      'AMOUNT_GREATER_THAN',
      'AMOUNT_GREATER_OR_EQUAL',
      'AMOUNT_LESS_THAN',
      'AMOUNT_BETWEEN',
      'PERCENT_OF_BUDGET',
      'OVER_BUDGET',
      'NEW_COUNTERPARTY',
      'SUPPLIER_BANK_DETAIL_CHANGED',
      'FUNDING_RESTRICTED',
      'CROSS_PROJECT',
      'CURRENCY_NOT_BASE',
      'MANUAL_FLAG',
    ])
    .nullable()
    .optional(),
  conditionValue: z.custom<Prisma.InputJsonValue>().optional(),
  isRequired: z.boolean().default(true),
  isFinalApprover: z.boolean().default(false),
});

const createPolicySchema = z.object({
  policyId: z.string().optional(),
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  entityType: z.enum([
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
  ]),
  isActive: z.boolean().default(true),
  priority: z.number().int().default(100),
  steps: z.array(stepSchema).min(1),
});

async function meta() {
  const h = await headers();
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: h.get('x-request-id') ?? randomUUID(),
  };
}

export async function createPolicyAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const context = await requireContext();
  await authorize(context, { module: 'APPROVALS', action: 'CONFIGURE' });

  const stepsData: Array<{
    id?: string;
    stepOrder: number;
    name: string;
    type: string;
    assigneeType: string;
    assigneeRoleId: string | null;
    assigneeUserId: string | null;
    resolutionMode: string;
    quorum: number | null;
    conditionOperator: string | null;
    conditionValue: Prisma.InputJsonValue | null;
    isRequired: boolean;
    isFinalApprover: boolean;
  }> = [];
  let index = 0;
  while (formData.has(`steps[${index}].name`)) {
    const stepId = formData.get(`steps[${index}].id`) as string | null;
    const conditionOperator = (formData.get(`steps[${index}].conditionOperator`) as string) || 'ALWAYS';
    let conditionValue: Prisma.InputJsonValue | null = null;

    if (conditionOperator === 'AMOUNT_GREATER_THAN' || conditionOperator === 'AMOUNT_GREATER_OR_EQUAL' || conditionOperator === 'AMOUNT_LESS_THAN') {
      const amount = formData.get(`steps[${index}].conditionValueAmount`);
      if (amount) conditionValue = { amount: parseFloat(amount as string) };
    } else if (conditionOperator === 'AMOUNT_BETWEEN') {
      const min = formData.get(`steps[${index}].conditionValueMin`);
      const max = formData.get(`steps[${index}].conditionValueMax`);
      if (min && max) conditionValue = { min: parseFloat(min as string), max: parseFloat(max as string) };
    } else if (conditionOperator === 'PERCENT_OF_BUDGET') {
      const percent = formData.get(`steps[${index}].conditionValuePercent`);
      if (percent) conditionValue = { percent: parseInt(percent as string, 10) };
    }

    stepsData.push({
      id: stepId || undefined,
      stepOrder: parseInt(formData.get(`steps[${index}].stepOrder`) as string, 10),
      name: formData.get(`steps[${index}].name`) as string,
      type: formData.get(`steps[${index}].type`) as string,
      assigneeType: formData.get(`steps[${index}].assigneeType`) as string,
      assigneeRoleId: formData.get(`steps[${index}].assigneeRoleId`) as string || null,
      assigneeUserId: formData.get(`steps[${index}].assigneeUserId`) as string || null,
      resolutionMode: formData.get(`steps[${index}].resolutionMode`) as string,
      quorum: formData.get(`steps[${index}].quorum`) ? parseInt(formData.get(`steps[${index}].quorum`) as string, 10) : null,
      conditionOperator,
      conditionValue,
      isRequired: formData.get(`steps[${index}].isRequired`) === 'on',
      isFinalApprover: formData.get(`steps[${index}].isFinalApprover`) === 'on',
    });
    index++;
  }

  const parsed = createPolicySchema.safeParse({
    name: formData.get('name'),
    description: formData.get('description') || undefined,
    entityType: formData.get('entityType'),
    isActive: formData.get('isActive') === 'on',
    priority: parseInt(formData.get('priority') as string, 10),
    steps: stepsData,
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? 'Check the details and try again.',
    };
  }

  const { name, description, entityType, isActive, priority, steps } = parsed.data;
  const m = await meta();

  try {
    const policy = await withAudit(
      {
        organizationId: context.actor.organizationId,
        actor: { id: context.actor.userId, name: context.actor.fullName, roleCodes: context.actor.roleCodes },
        ipAddress: m.ipAddress,
        userAgent: m.userAgent,
        requestId: m.requestId,
        sessionId: context.actor.sessionId,
      },
      async (tx) => {
        const created = await tx.approvalPolicy.create({
          data: {
            organizationId: context.actor.organizationId!,
            name,
            description,
            entityType,
            isActive,
            priority,
            createdById: context.actor.userId,
            steps: {
              create: steps.map((step) => ({
                stepOrder: step.stepOrder,
                name: step.name,
                type: step.type,
                assigneeType: step.assigneeType,
                assigneeRoleId: step.assigneeRoleId,
                assigneeUserId: step.assigneeUserId,
                resolutionMode: step.resolutionMode,
                quorum: step.quorum,
                conditionOperator: step.conditionOperator,
                conditionValue: step.conditionValue ?? Prisma.JsonNull,
                isRequired: step.isRequired,
                isFinalApprover: step.isFinalApprover,
              })),
            },
          },
          include: { steps: { orderBy: { stepOrder: 'asc' } } },
        });

        await writeAuditEntry(
          tx,
          { id: context.actor.userId, name: context.actor.fullName, roleCodes: context.actor.roleCodes },
          {
            action: 'APPROVAL_POLICY_CREATED',
            entityType: 'APPROVAL_POLICY',
            entityId: created.id,
            entityLabel: created.name,
            description: `Approval policy "${created.name}" created`,
            metadata: { entityType: created.entityType, stepsCount: created.steps.length },
            result: 'SUCCESS',
            channel: 'WEB',
          },
          { organizationId: context.actor.organizationId, requestId: m.requestId },
        );

        return created;
      },
    );

    revalidatePath('/approvals/policies');
    return { ok: true, message: `Policy "${name}" created.`, data: { id: policy.id } };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'An unexpected error occurred.' };
  }
}

export async function updatePolicyAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const context = await requireContext();
  await authorize(context, { module: 'APPROVALS', action: 'CONFIGURE' });

  const policyId = formData.get('policyId') as string;
  if (!policyId) return { ok: false, message: 'Policy ID is required.' };

  const stepsData: Array<{
    id?: string;
    stepOrder: number;
    name: string;
    type: string;
    assigneeType: string;
    assigneeRoleId: string | null;
    assigneeUserId: string | null;
    resolutionMode: string;
    quorum: number | null;
    conditionOperator: string | null;
    conditionValue: Prisma.InputJsonValue | null;
    isRequired: boolean;
    isFinalApprover: boolean;
  }> = [];
  let index = 0;
  while (formData.has(`steps[${index}].name`)) {
    const stepId = formData.get(`steps[${index}].id`) as string | null;
    const conditionOperator = (formData.get(`steps[${index}].conditionOperator`) as string) || 'ALWAYS';
    let conditionValue: Prisma.InputJsonValue | null = null;

    if (conditionOperator === 'AMOUNT_GREATER_THAN' || conditionOperator === 'AMOUNT_GREATER_OR_EQUAL' || conditionOperator === 'AMOUNT_LESS_THAN') {
      const amount = formData.get(`steps[${index}].conditionValueAmount`);
      if (amount) conditionValue = { amount: parseFloat(amount as string) };
    } else if (conditionOperator === 'AMOUNT_BETWEEN') {
      const min = formData.get(`steps[${index}].conditionValueMin`);
      const max = formData.get(`steps[${index}].conditionValueMax`);
      if (min && max) conditionValue = { min: parseFloat(min as string), max: parseFloat(max as string) };
    } else if (conditionOperator === 'PERCENT_OF_BUDGET') {
      const percent = formData.get(`steps[${index}].conditionValuePercent`);
      if (percent) conditionValue = { percent: parseInt(percent as string, 10) };
    }

    stepsData.push({
      id: stepId || undefined,
      stepOrder: parseInt(formData.get(`steps[${index}].stepOrder`) as string, 10),
      name: formData.get(`steps[${index}].name`) as string,
      type: formData.get(`steps[${index}].type`) as string,
      assigneeType: formData.get(`steps[${index}].assigneeType`) as string,
      assigneeRoleId: formData.get(`steps[${index}].assigneeRoleId`) as string || null,
      assigneeUserId: formData.get(`steps[${index}].assigneeUserId`) as string || null,
      resolutionMode: formData.get(`steps[${index}].resolutionMode`) as string,
      quorum: formData.get(`steps[${index}].quorum`) ? parseInt(formData.get(`steps[${index}].quorum`) as string, 10) : null,
      conditionOperator,
      conditionValue,
      isRequired: formData.get(`steps[${index}].isRequired`) === 'on',
      isFinalApprover: formData.get(`steps[${index}].isFinalApprover`) === 'on',
    });
    index++;
  }

  const parsed = createPolicySchema.safeParse({
    policyId,
    name: formData.get('name'),
    description: formData.get('description') || undefined,
    entityType: formData.get('entityType'),
    isActive: formData.get('isActive') === 'on',
    priority: parseInt(formData.get('priority') as string, 10),
    steps: stepsData,
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? 'Check the details and try again.',
    };
  }

  const { name, description, entityType, isActive, priority, steps } = parsed.data;
  const m = await meta();

  try {
    await withAudit(
      {
        organizationId: context.actor.organizationId,
        actor: { id: context.actor.userId, name: context.actor.fullName, roleCodes: context.actor.roleCodes },
        ipAddress: m.ipAddress,
        userAgent: m.userAgent,
        requestId: m.requestId,
        sessionId: context.actor.sessionId,
      },
      async (tx) => {
        const orgId = context.actor.organizationId!;
        const existingPolicy = await tx.approvalPolicy.findFirst({
          where: { id: policyId, organizationId: orgId },
          include: { steps: true },
        });

        if (!existingPolicy) throw new Error('Policy not found');

        const existingStepsCount = existingPolicy.steps.length;

        await tx.approvalPolicyStep.deleteMany({ where: { policyId } });

        const updated = await tx.approvalPolicy.update({
          where: { id: policyId },
          data: {
            name,
            description,
            entityType,
            isActive,
            priority,
            updatedById: context.actor.userId,
            steps: {
              create: steps.map((step) => ({
                stepOrder: step.stepOrder,
                name: step.name,
                type: step.type,
                assigneeType: step.assigneeType,
                assigneeRoleId: step.assigneeRoleId,
                assigneeUserId: step.assigneeUserId,
                resolutionMode: step.resolutionMode,
                quorum: step.quorum,
                conditionOperator: step.conditionOperator,
                conditionValue: step.conditionValue ?? Prisma.JsonNull,
                isRequired: step.isRequired,
                isFinalApprover: step.isFinalApprover,
              })),
            },
          },
          include: { steps: { orderBy: { stepOrder: 'asc' } } },
        });

        await writeAuditEntry(
          tx,
          { id: context.actor.userId, name: context.actor.fullName, roleCodes: context.actor.roleCodes },
          {
            action: 'APPROVAL_POLICY_UPDATED',
            entityType: 'APPROVAL_POLICY',
            entityId: updated.id,
            entityLabel: updated.name,
            description: `Approval policy "${updated.name}" updated`,
            changes: {
              name: { from: existingPolicy.name, to: updated.name },
              isActive: { from: existingPolicy.isActive, to: updated.isActive },
              priority: { from: existingPolicy.priority, to: updated.priority },
              stepsCount: { from: existingStepsCount, to: updated.steps.length },
            },
            result: 'SUCCESS',
            channel: 'WEB',
          },
          { organizationId: orgId, requestId: m.requestId },
        );
      },
    );

    revalidatePath('/approvals/policies');
    revalidatePath(`/approvals/policies?edit=${policyId}`);
    return { ok: true, message: `Policy "${name}" updated.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'An unexpected error occurred.' };
  }
}