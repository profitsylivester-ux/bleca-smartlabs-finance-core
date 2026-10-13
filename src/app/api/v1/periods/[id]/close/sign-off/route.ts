import { NextResponse } from 'next/server';
import { z } from 'zod';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';
import { signOffClose } from '@/lib/close/service';
import { advanceRequest } from '@/lib/approvals/engine';

const signOffSchema = z.object({
  approvalRequestId: z.string().cuid(),
  decision: z.enum(['APPROVED', 'REJECTED']),
  reason: z.string().min(5).max(1000).optional(),
});

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    // CEO sign-off requires APPROVE permission on FINANCIAL_CLOSE
    await authorize(ctx, { module: 'FINANCIAL_CLOSE', action: 'APPROVE' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const key = request.headers.get('idempotency-key');
    if (!key) {
      return apiError(
        new ValidationError('An Idempotency-Key header is required on this endpoint.'),
        reqId,
      );
    }

    const { id } = await params;
    const body = signOffSchema.parse(await request.json());

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/periods/${id}/close/sign-off`,
      actorId: ctx.actor.userId,
      body,
      handler: async () =>
        withAudit(
          {
            organizationId: ctx.actor.organizationId,
            actor: {
              id: ctx.actor.userId,
              name: ctx.actor.fullName,
              roleCodes: ctx.actor.roleCodes,
            },
            ipAddress: net.ipAddress,
            userAgent: net.userAgent,
            requestId: reqId,
            sessionId: ctx.actor.sessionId,
          },
          async (tx) => {
            const period = await tx.financialPeriod.findFirst({
              where: { id, organizationId: ctx.actor.organizationId! },
              select: { id: true, code: true, name: true, status: true },
            });

            if (!period) throw new NotFoundError('Financial period', id);

            // Verify the approval request exists and is for this close
            const approvalRequest = await tx.approvalRequest.findUnique({
              where: { id: body.approvalRequestId },
              select: {
                id: true,
                status: true,
                entityType: true,
                entityId: true,
                organizationId: true,
                currentStepIndex: true,
                stepInstances: {
                  orderBy: { stepOrder: 'asc' },
                  select: { id: true, stepOrder: true, status: true },
                },
              },
            });

            if (!approvalRequest) {
              throw new NotFoundError('Approval request', body.approvalRequestId);
            }

            if (approvalRequest.organizationId !== ctx.actor.organizationId!) {
              throw new ValidationError('Approval request does not belong to this organization');
            }

            if (approvalRequest.entityType !== 'FINANCIAL_CLOSE') {
              throw new ValidationError('Approval request is not for a financial close');
            }

            // Verify this approval request is for the correct close
            const close = await tx.financialClose.findFirst({
              where: { periodId: id, organizationId: ctx.actor.organizationId! },
              select: { id: true, approvalRequestId: true, status: true },
            });

            if (!close) {
              throw new NotFoundError('Financial close session', id);
            }

            if (close.approvalRequestId !== body.approvalRequestId) {
              throw new ValidationError('Approval request does not match this close session');
            }

            // Advance the approval request with the CEO's decision
            await advanceRequest(
              body.approvalRequestId,
              body.decision,
              {
                userId: ctx.actor.userId,
                fullName: ctx.actor.fullName,
                roleCodes: ctx.actor.roleCodes,
              },
              { reason: body.reason, tx },
            );

            // If approved, sign off the close
            if (body.decision === 'APPROVED') {
              const result = await signOffClose(
                id,
                ctx.actor.organizationId!,
                ctx.actor.userId,
                ctx.actor.fullName,
                ctx.actor.roleCodes,
                tx,
              );

              return { status: 200, body: { data: { ...result, decision: 'APPROVED' } } };
            } else {
              // If rejected, update close status back to IN_PROGRESS
              const updatedClose = await tx.financialClose.update({
                where: { id: close.id },
                data: {
                  status: 'IN_PROGRESS',
                  submittedById: null,
                  submittedAt: null,
                  approvalRequestId: null,
                },
                select: { id: true, status: true },
              });

              // Also update period status back to CLOSING
              await tx.financialPeriod.update({
                where: { id },
                data: { status: 'CLOSING' },
              });

              await writeAuditEntry(
                tx,
                { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
                {
                  action: 'FINANCIAL_CLOSE_SIGNED_OFF',
                  entityType: 'FINANCIAL_CLOSE',
                  entityId: close.id,
                  entityLabel: close.id,
                  description: `CEO rejected financial close ${close.id} for period ${period.code}`,
                  changes: {
                    closeStatus: { from: 'SUBMITTED', to: 'IN_PROGRESS' },
                    periodStatus: { from: 'CLOSING', to: 'CLOSING' },
                    rejectionReason: { from: null, to: body.reason ?? null },
                  },
                  metadata: { approvalRequestId: body.approvalRequestId },
                  result: 'SUCCESS',
                  channel: 'WEB',
                },
                { organizationId: ctx.actor.organizationId },
              );

              return {
                status: 200,
                body: {
                  data: { closeId: updatedClose.id, periodStatus: 'CLOSING', decision: 'REJECTED' as const },
                },
              };
            }
          },
        ),
    });

    if (outcome.kind === 'REPLAYED') {
      return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    }

    return ok(outcome.result, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}