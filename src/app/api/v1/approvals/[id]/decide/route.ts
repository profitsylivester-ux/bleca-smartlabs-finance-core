import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { writeAuditEntry } from '@/lib/audit/writer';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';
import { advanceRequest } from '@/lib/approvals';

const decideSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED', 'DEFERRED', 'RETURNED_FOR_CHANGES', 'SKIPPED', 'CANCELLED']),
  reason: z.string().optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ organizationId: string; id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'APPROVALS', action: 'APPROVE' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const key = request.headers.get('idempotency-key');
    if (!key) {
      return apiError(new ValidationError('An Idempotency-Key header is required on this endpoint.'), reqId);
    }

    const { id } = await params;
    const orgId = ctx.actor.organizationId!;

    const body = decideSchema.parse(await request.json());

    const existingRequest = await prisma.approvalRequest.findFirst({
      where: { id, organizationId: orgId },
      include: { stepInstances: { orderBy: { stepOrder: 'asc' } } },
    });

    if (!existingRequest) {
      return apiError(new NotFoundError('ApprovalRequest', id), reqId);
    }

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/approvals/${id}/decide`,
      actorId: ctx.actor.userId,
      body: await request.json(),
      handler: async (tx) => {
        const result = await advanceRequest(
          id,
          body.decision,
          { userId: ctx.actor.userId, fullName: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
          { reason: body.reason, tx }
        );

        await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, {
          action: 'APPROVAL_STEP_DECIDED',
          entityType: 'APPROVAL_STEP_INSTANCE',
          entityId: result.stepInstance?.id ?? '',
          entityLabel: result.stepInstance?.stepName ?? '',
          description: `Step "${result.stepInstance?.stepName}" ${body.decision.toLowerCase()} for request ${id}`,
          changes: {
            stepStatus: { from: 'PENDING', to: body.decision },
            requestStatus: { from: existingRequest.status, to: result.request.status },
          },
          metadata: {
            decision: body.decision,
            reason: body.reason ?? null,
            sodViolation: result.decisionRecord.sodViolation,
            sodWaiverId: result.decisionRecord.sodWaiverId,
            delegationId: result.decisionRecord.delegationId,
            actorRoleCodes: ctx.actor.roleCodes,
          },
          result: 'SUCCESS',
          channel: 'WEB',
        }, { organizationId: orgId, requestId: reqId });

        if (result.isComplete) {
          await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, {
            action: body.decision === 'REJECTED' ? 'APPROVAL_REQUEST_REJECTED' : 'APPROVAL_REQUEST_APPROVED',
            entityType: 'APPROVAL_REQUEST',
            entityId: id,
            entityLabel: id,
            description: `Approval request ${id} ${body.decision.toLowerCase()}`,
            changes: { status: { from: existingRequest.status, to: result.request.status } },
            metadata: { actorRoleCodes: ctx.actor.roleCodes },
            result: 'SUCCESS',
            channel: 'WEB',
          }, { organizationId: orgId, requestId: reqId });
        }

        return { status: 200, body: result };
      },
    });

    if (outcome.kind === 'REPLAYED') {
      return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    }

    return ok(outcome.result, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}