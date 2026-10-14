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

const updateSchema = z.object({
  description: z.string().max(500).optional(),
  amount: z.number().positive().optional(),
  currencyCode: z.string().length(3).toUpperCase().optional(),
  frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUALLY', 'CUSTOM']).optional(),
  nextDueDate: z.string().min(1).optional(),
  endDate: z.string().min(1).nullable().optional(),
  status: z.enum(['SCHEDULED', 'DUE', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED']).optional(),
});

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

function computeStatus(nextDueDate: Date, endDate: Date | null, currentStatus: string): string {
  if (currentStatus === 'CANCELLED' || currentStatus === 'PAID') {
    return currentStatus;
  }
  const now = new Date();
  const due = new Date(nextDueDate);
  if (endDate && new Date(endDate) < now) {
    return 'OVERDUE';
  }
  if (due <= now) {
    return 'OVERDUE';
  }
  return 'SCHEDULED';
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'TREASURY_TRANSFERS', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const { id } = await params;

    const schedule = await prisma.paymentSchedule.findFirst({
      where: { id, organizationId: ctx.actor.organizationId },
      select: {
        id: true,
        code: true,
        description: true,
        amount: true,
        currencyCode: true,
        frequency: true,
        nextDueDate: true,
        endDate: true,
        status: true,
        treasuryAccountId: true,
        treasuryAccount: { select: { id: true, code: true, name: true, kind: true } },
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!schedule) {
      return apiError(new NotFoundError('Payment schedule', id), reqId);
    }

    const scheduleWithComputedStatus = {
      ...schedule,
      status: computeStatus(schedule.nextDueDate, schedule.endDate, schedule.status),
    };

    return ok({ data: scheduleWithComputedStatus }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'TREASURY_TRANSFERS', action: 'EDIT' });

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
    const body = updateSchema.parse(await request.json());

    const existing = await prisma.paymentSchedule.findFirst({
      where: { id, organizationId: ctx.actor.organizationId },
      select: { id: true, code: true, description: true, amount: true, currencyCode: true, treasuryAccountId: true, status: true },
    });
    if (!existing) {
      return apiError(new NotFoundError('Payment schedule', id), reqId);
    }

    if (body.currencyCode && body.currencyCode !== existing.currencyCode) {
      const treasuryAccount = await prisma.treasuryAccount.findUnique({
        where: { id: existing.treasuryAccountId },
        select: { currencyCode: true },
      });
      if (treasuryAccount && body.currencyCode !== treasuryAccount.currencyCode) {
        return apiError(
          new ValidationError(`Currency mismatch: treasury account uses ${treasuryAccount.currencyCode}, request uses ${body.currencyCode}`),
          reqId,
        );
      }
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `PATCH /api/v1/payment-schedules/${id}`,
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
            const data: Record<string, unknown> = { ...body };
            if (body.nextDueDate) data.nextDueDate = new Date(body.nextDueDate);
            if (body.endDate !== undefined) data.endDate = body.endDate ? new Date(body.endDate) : null;

            const updated = await tx.paymentSchedule.update({
              where: { id },
              data,
              select: {
                id: true,
                code: true,
                description: true,
                amount: true,
                currencyCode: true,
                frequency: true,
                nextDueDate: true,
                endDate: true,
                status: true,
                treasuryAccountId: true,
                createdAt: true,
                updatedAt: true,
              },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'PAYMENT_SCHEDULE',
                entityId: updated.id,
                entityLabel: updated.code,
                description: `Updated payment schedule ${updated.code}`,
                changes: {
                  description: { from: existing.description, to: updated.description },
                  amount: { from: existing.amount, to: updated.amount },
                  status: { from: existing.status, to: updated.status },
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

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'TREASURY_TRANSFERS', action: 'EDIT' });

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

    const existing = await prisma.paymentSchedule.findFirst({
      where: { id, organizationId: ctx.actor.organizationId },
      select: { id: true, code: true, status: true },
    });
    if (!existing) {
      return apiError(new NotFoundError('Payment schedule', id), reqId);
    }

    if (existing.status !== 'SCHEDULED' && existing.status !== 'CANCELLED') {
      return apiError(new ValidationError('Can only cancel scheduled or already cancelled payment schedules'), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `DELETE /api/v1/payment-schedules/${id}`,
      actorId: ctx.actor.userId,
      body: {},
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
            await tx.paymentSchedule.update({
              where: { id },
              data: { status: 'CANCELLED' },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'PAYMENT_SCHEDULE',
                entityId: id,
                entityLabel: existing.code,
                description: `Cancelled payment schedule ${existing.code}`,
                changes: { status: { from: existing.status, to: 'CANCELLED' } },
              },
              {
                organizationId: ctx.actor.organizationId,
                ipAddress: net.ipAddress,
                userAgent: net.userAgent,
                requestId: reqId,
                sessionId: ctx.actor.sessionId,
              },
            );

            return { status: 200, body: { data: { id, status: 'CANCELLED' } } };
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
