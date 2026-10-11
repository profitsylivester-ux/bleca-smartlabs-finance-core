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
import { advanceRequest } from '@/lib/approvals';
import { Prisma } from '@/generated/prisma/client';

export interface ActionResult {
  ok: boolean;
  message?: string;
  data?: Record<string, unknown>;
}

const decideSchema = z.object({
  requestId: z.string().min(1),
  stepInstanceId: z.string().min(1),
  decision: z.enum(['APPROVED', 'REJECTED', 'DEFERRED', 'RETURNED_FOR_CHANGES', 'SKIPPED', 'CANCELLED']),
  reason: z.string().optional(),
});

const requestInclude = {
  stepInstances: { orderBy: { stepOrder: 'asc' as const } },
} satisfies Prisma.ApprovalRequestInclude;

type ApprovalRequestWithSteps = Prisma.ApprovalRequestGetPayload<{ include: typeof requestInclude }>;

export async function decideApprovalAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const context = await requireContext();
  await authorize(context, { module: 'APPROVALS', action: 'APPROVE' });

  const parsed = decideSchema.safeParse({
    requestId: String(formData.get('requestId') ?? ''),
    stepInstanceId: String(formData.get('stepInstanceId') ?? ''),
    decision: String(formData.get('decision') ?? ''),
    reason: String(formData.get('reason') ?? '').trim() || undefined,
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? 'Check the details and try again.',
    };
  }

  const { requestId, stepInstanceId, decision, reason } = parsed.data;
  const orgId = context.actor.organizationId!;

  const existingRequest = await prisma.approvalRequest.findFirst({
    where: { id: requestId, organizationId: orgId },
    include: requestInclude,
  }) as ApprovalRequestWithSteps | null;

  if (!existingRequest) {
    return { ok: false, message: 'Approval request not found.' };
  }

  const stepInstance = existingRequest.stepInstances.find((si) => si.id === stepInstanceId);
  if (!stepInstance) {
    return { ok: false, message: 'Step instance not found.' };
  }

  if (stepInstance.status !== 'PENDING') {
    return { ok: false, message: 'This step has already been decided.' };
  }

  const m = await (async () => {
    const h = await headers();
    return {
      ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
      userAgent: h.get('user-agent'),
      requestId: h.get('x-request-id') ?? randomUUID(),
    };
  })();

  try {
    const result = await withAudit(
      {
        organizationId: context.actor.organizationId,
        actor: {
          id: context.actor.userId,
          name: context.actor.fullName,
          roleCodes: context.actor.roleCodes,
        },
        ipAddress: m.ipAddress,
        userAgent: m.userAgent,
        requestId: m.requestId,
        sessionId: context.actor.sessionId,
      },
      async (tx) => {
        const advanceResult = await advanceRequest(
          requestId,
          decision,
          { userId: context.actor.userId, fullName: context.actor.fullName, roleCodes: context.actor.roleCodes },
          { reason, tx }
        );

        await writeAuditEntry(
          tx,
          { id: context.actor.userId, name: context.actor.fullName, roleCodes: context.actor.roleCodes },
          {
            action: 'APPROVAL_STEP_DECIDED',
            entityType: 'APPROVAL_STEP_INSTANCE',
            entityId: stepInstance.id,
            entityLabel: stepInstance.stepName,
            description: `Step "${stepInstance.stepName}" ${decision.toLowerCase()} for request ${requestId}`,
            changes: {
              stepStatus: { from: 'PENDING', to: decision === 'APPROVED' ? 'APPROVED' : decision },
              requestStatus: { from: existingRequest.status, to: advanceResult.request.status },
            },
            metadata: {
              decision,
              reason: reason ?? null,
              sodViolation: advanceResult.decisionRecord.sodViolation,
              sodWaiverId: advanceResult.decisionRecord.sodWaiverId,
              delegationId: advanceResult.decisionRecord.delegationId,
              actorRoleCodes: context.actor.roleCodes,
            },
            result: 'SUCCESS',
            channel: 'WEB',
          },
          { organizationId: context.actor.organizationId, requestId: m.requestId },
        );

        if (advanceResult.isComplete) {
          await writeAuditEntry(
            tx,
            { id: context.actor.userId, name: context.actor.fullName, roleCodes: context.actor.roleCodes },
            {
              action: decision === 'REJECTED' ? 'APPROVAL_REQUEST_REJECTED' : 'APPROVAL_REQUEST_APPROVED',
              entityType: 'APPROVAL_REQUEST',
              entityId: requestId,
              entityLabel: requestId,
              description: `Approval request ${requestId} ${decision.toLowerCase()}`,
              changes: { status: { from: existingRequest.status, to: advanceResult.request.status } },
              metadata: { actorRoleCodes: context.actor.roleCodes },
              result: 'SUCCESS',
              channel: 'WEB',
            },
            { organizationId: context.actor.organizationId, requestId: m.requestId },
          );
        }

        return advanceResult;
      },
    );

    revalidatePath(`/approvals/${requestId}`);
    revalidatePath('/approvals');

    if (result.isComplete) {
      return {
        ok: true,
        message: `Request ${decision === 'REJECTED' ? 'rejected' : 'approved'}.`,
      };
    }

    return {
      ok: true,
      message: `Step "${stepInstance.stepName}" ${decision.toLowerCase()}.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'An unexpected error occurred.',
    };
  }
}