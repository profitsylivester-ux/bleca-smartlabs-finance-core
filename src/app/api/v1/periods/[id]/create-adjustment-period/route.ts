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

const adjustmentPeriodSchema = z.object({
  code: z.string().min(2).max(50).toUpperCase(),
  name: z.string().min(2).max(120),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
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
    await authorize(ctx, { module: 'FINANCIAL_CLOSE', action: 'CREATE' });

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
    const body = adjustmentPeriodSchema.parse(await request.json());

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/periods/${id}/create-adjustment-period`,
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
              select: { id: true, code: true, name: true, status: true, type: true, startDate: true, endDate: true },
            });

            if (!period) throw new NotFoundError('Financial period', id);

            if (period.status !== 'LOCKED') {
              throw new ValidationError(
                `Cannot create adjustment period for period with status ${period.status}. Only LOCKED periods can have adjustment periods.`,
              );
            }

            // Check if an adjustment period already exists for this period
            const existingAdj = await tx.financialPeriod.findFirst({
              where: {
                organizationId: ctx.actor.organizationId!,
                isAdjustment: true,
                // Adjustment periods typically reference the parent period
                // We'll use a convention: adjustment period code starts with parent code
              },
              select: { id: true },
            });

            // For now, allow multiple adjustment periods but warn
            // In practice, we might want to restrict to one per locked period

            const startDate = new Date(body.startDate);
            const endDate = new Date(body.endDate);

            if (startDate >= endDate) {
              throw new ValidationError('Start date must be before end date');
            }

            // Adjustment period should be within or after the parent period
            if (startDate < period.startDate) {
              throw new ValidationError('Adjustment period cannot start before the parent period');
            }

            const existing = await tx.financialPeriod.findUnique({
              where: { organizationId_code: { organizationId: ctx.actor.organizationId!, code: body.code } },
              select: { id: true },
            });
            if (existing) {
              throw new ValidationError('A period with this code already exists.');
            }

            const created = await tx.financialPeriod.create({
              data: {
                organizationId: ctx.actor.organizationId!,
                type: 'MONTHLY', // Adjustment periods are typically monthly
                status: 'OPEN',
                code: body.code,
                name: body.name,
                startDate,
                endDate,
                isAdjustment: true,
              },
              select: {
                id: true,
                type: true,
                status: true,
                code: true,
                name: true,
                startDate: true,
                endDate: true,
                isAdjustment: true,
                reopenCount: true,
                closedAt: true,
                lockedAt: true,
                createdAt: true,
                updatedAt: true,
              },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'ADJUSTMENT_PERIOD_CREATED',
                entityType: 'FINANCIAL_PERIOD',
                entityId: created.id,
                entityLabel: created.code,
                description: `Created adjustment period ${created.code} (${created.name}) for locked period ${period.code}`,
                changes: {
                  parentPeriodId: { from: null, to: period.id },
                  parentPeriodCode: { from: null, to: period.code },
                  code: { from: null, to: created.code },
                  name: { from: null, to: created.name },
                  startDate: { from: null, to: created.startDate.toISOString() },
                  endDate: { from: null, to: created.endDate.toISOString() },
                  isAdjustment: { from: null, to: true },
                },
              },
              { organizationId: ctx.actor.organizationId },
            );

            return { status: 201, body: { data: created } };
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
