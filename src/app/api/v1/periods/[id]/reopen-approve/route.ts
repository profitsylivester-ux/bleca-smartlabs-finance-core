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

const reopenApproveSchema = z.object({
  approvalNote: z.string().min(5).max(1000),
});

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

async function getPeriod(id: string, orgId: string) {
  return prisma.financialPeriod.findFirst({
    where: { id, organizationId: orgId },
    select: {
      id: true,
      type: true,
      status: true,
      code: true,
      name: true,
      reopenCount: true,
    },
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'MASTER_DATA', action: 'APPROVE' });

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
    const body = reopenApproveSchema.parse(await request.json());

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/periods/${id}/reopen-approve`,
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
            const existing = await getPeriod(id, ctx.actor.organizationId!);
            if (!existing) throw new NotFoundError('Financial period', id);

            if (existing.status !== 'REOPEN_PENDING') {
              throw new ValidationError(`Cannot approve reopen for period with status ${existing.status}. Only REOPEN_PENDING periods can be approved.`);
            }

            const approvalRequest = await tx.masterDataChangeRequest.findFirst({
              where: {
                entityType: 'FINANCIAL_PERIOD',
                entityId: id,
                status: 'PENDING_APPROVAL',
              },
              orderBy: { createdAt: 'desc' },
              select: { id: true },
            });

            if (!approvalRequest) {
              throw new ValidationError('No pending reopen request found for this period.');
            }

            const updated = await tx.financialPeriod.update({
              where: { id },
              data: {
                status: 'REOPENED',
                reopenCount: { increment: 1 },
              },
              select: {
                id: true,
                type: true,
                status: true,
                code: true,
                name: true,
                reopenCount: true,
              },
            });

            await tx.masterDataChangeRequest.update({
              where: { id: approvalRequest.id },
              data: {
                status: 'APPROVED',
                approvedById: ctx.actor.userId,
                approvedAt: new Date(),
              },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'FINANCIAL_PERIOD',
                entityId: updated.id,
                entityLabel: updated.code,
                description: `Approved reopen of period ${updated.code} (${updated.name})`,
                changes: {
                  status: { from: 'REOPEN_PENDING', to: 'REOPENED' },
                  reopenCount: { from: existing.reopenCount, to: updated.reopenCount },
                  approvalNote: { from: null, to: body.approvalNote },
                  approvalRequestId: { from: approvalRequest.id, to: approvalRequest.id },
                },
              },
              {
                organizationId: ctx.actor.organizationId,
                ipAddress: net.ipAddress,
                userAgent: net.userAgent,
                requestId: reqId,
                sessionId: ctx.actor.sessionId,
              },
            );

            return { status: 200, body: { data: updated } };
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