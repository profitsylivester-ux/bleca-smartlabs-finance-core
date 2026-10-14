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

const reopenRequestSchema = z.object({
  reason: z.string().min(10).max(1000),
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
      startDate: true,
      endDate: true,
      reopenCount: true,
      closedAt: true,
      lockedAt: true,
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
    await authorize(ctx, { module: 'MASTER_DATA', action: 'EDIT' });

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
    const body = reopenRequestSchema.parse(await request.json());

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/periods/${id}/reopen-request`,
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

            if (existing.status !== 'LOCKED') {
              throw new ValidationError(`Cannot request reopen for period with status ${existing.status}. Only LOCKED periods can be reopened.`);
            }

            const updated = await tx.financialPeriod.update({
              where: { id },
              data: { status: 'REOPEN_PENDING' },
              select: {
                id: true,
                type: true,
                status: true,
                code: true,
                name: true,
                reopenCount: true,
              },
            });

            const approvalRequest = await tx.masterDataChangeRequest.create({
              data: {
                organizationId: ctx.actor.organizationId!,
                entityType: 'FINANCIAL_PERIOD',
                entityId: id,
                proposedChanges: {
                  status: 'REOPENED',
                  reopenReason: body.reason,
                },
                reason: `Reopen request for period ${existing.code}: ${body.reason}`,
                status: 'PENDING_APPROVAL',
                requestedById: ctx.actor.userId,
                effectiveDate: new Date(),
              },
              select: { id: true, status: true },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'FINANCIAL_PERIOD',
                entityId: updated.id,
                entityLabel: updated.code,
                description: `Requested reopen of period ${updated.code} (${updated.name})`,
                changes: {
                  status: { from: existing.status, to: 'REOPEN_PENDING' },
                  approvalRequestId: { from: null, to: approvalRequest.id },
                  reopenReason: { from: null, to: body.reason },
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

            return { status: 201, body: { data: { period: updated, approvalRequest } } };
          },
        ),
    });

    if (outcome.kind === 'REPLAYED') {
      return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    }

    return ok(outcome.result, 201, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}