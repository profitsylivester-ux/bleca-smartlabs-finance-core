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
import { waiveChecklistItem } from '@/lib/close/service';

const waiveSchema = z.object({
  reason: z.string().min(10).max(1000),
  waiverApproverId: z.string().cuid(),
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
  { params }: { params: Promise<{ id: string; itemKey: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'FINANCIAL_CLOSE', action: 'EDIT' });

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

    const { id, itemKey } = await params;
    const body = waiveSchema.parse(await request.json());

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/periods/${id}/close/items/${itemKey}/waive`,
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

            // Verify waiver approver exists and is active
            const approver = await tx.user.findUnique({
              where: { id: body.waiverApproverId },
              select: { id: true, isActive: true, status: true, deletedAt: true },
            });

            if (!approver || !approver.isActive || approver.deletedAt || approver.status !== 'ACTIVE') {
              throw new ValidationError('Waiver approver is not an active user');
            }

            const result = await waiveChecklistItem(
              id,
              itemKey,
              ctx.actor.organizationId!,
              ctx.actor.userId,
              ctx.actor.fullName,
              ctx.actor.roleCodes,
              body.reason,
              body.waiverApproverId,
              tx,
            );

            return { status: 200, body: { data: result } };
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