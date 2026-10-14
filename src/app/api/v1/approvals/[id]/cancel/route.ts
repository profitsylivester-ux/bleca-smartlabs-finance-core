import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { writeAuditEntry } from '@/lib/audit/writer';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';
import { cancelApprovalRequest } from '@/lib/approvals';

const cancelSchema = z.object({
  reason: z.string().optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'APPROVALS', action: 'REJECT' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const key = request.headers.get('idempotency-key');
    if (!key) {
      return apiError(new ValidationError('An Idempotency-Key header is required on this endpoint.'), reqId);
    }

    const { id } = await params;
    const orgId = ctx.actor.organizationId!;

    const body = cancelSchema.parse(await request.json());

    const existingRequest = await prisma.approvalRequest.findFirst({
      where: { id, organizationId: orgId },
    });

    if (!existingRequest) {
      return apiError(new NotFoundError('ApprovalRequest', id), reqId);
    }

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/approvals/${id}/cancel`,
      actorId: ctx.actor.userId,
      body: await request.json(),
      handler: async (tx) => {
        const updatedRequest = await cancelApprovalRequest(
          id,
          { userId: ctx.actor.userId, fullName: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
          body.reason,
          tx
        );

        await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, {
          action: 'APPROVAL_REQUEST_CANCELLED',
          entityType: 'APPROVAL_REQUEST',
          entityId: id,
          entityLabel: id,
          description: `Approval request ${id} cancelled`,
          changes: { status: { from: existingRequest.status, to: 'CANCELLED' } },
          metadata: { reason: body.reason ?? null, actorRoleCodes: ctx.actor.roleCodes },
          result: 'SUCCESS',
          channel: 'WEB',
        }, { organizationId: orgId, requestId: reqId });

        return { status: 200, body: updatedRequest };
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