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
import { ConflictError, NotFoundError, ValidationError } from '@/lib/kernel/errors';

const frequencySchema = z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUALLY', 'CUSTOM']);

const createSchema = z.object({
  code: z.string().min(2).max(50).toUpperCase(),
  treasuryAccountId: z.string().cuid(),
  description: z.string().max(500).optional(),
  amount: z.number().positive(),
  currencyCode: z.string().length(3).toUpperCase(),
  frequency: frequencySchema,
  nextDueDate: z.string().datetime(),
  endDate: z.string().datetime().optional(),
});

const updateSchema = z.object({
  description: z.string().max(500).optional(),
  amount: z.number().positive().optional(),
  currencyCode: z.string().length(3).toUpperCase().optional(),
  frequency: frequencySchema.optional(),
  nextDueDate: z.string().datetime().optional(),
  endDate: z.string().datetime().nullable().optional(),
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

export async function GET(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'TREASURY_TRANSFERS', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const treasuryAccountId = searchParams.get('treasuryAccountId');
    const overdueOnly = searchParams.get('overdueOnly') === 'true';

    const where: Record<string, unknown> = { organizationId: ctx.actor.organizationId };
    if (status) where.status = status;
    if (treasuryAccountId) where.treasuryAccountId = treasuryAccountId;
    if (overdueOnly) {
      where.nextDueDate = { lte: new Date() };
      where.status = { in: ['SCHEDULED', 'DUE', 'PARTIALLY_PAID'] };
    }

    const schedules = await prisma.paymentSchedule.findMany({
      where,
      orderBy: [{ nextDueDate: 'asc' }, { code: 'asc' }],
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

    const schedulesWithComputedStatus = schedules.map((s) => ({
      ...s,
      status: computeStatus(s.nextDueDate, s.endDate, s.status),
    }));

    return ok({ data: schedulesWithComputedStatus, count: schedulesWithComputedStatus.length }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function POST(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'TREASURY_TRANSFERS', action: 'CREATE' });

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

    const body = createSchema.parse(await request.json());

    const treasuryAccount = await prisma.treasuryAccount.findUnique({
      where: { id: body.treasuryAccountId },
      select: { id: true, organizationId: true, currencyCode: true, isActive: true },
    });
    if (!treasuryAccount || treasuryAccount.organizationId !== ctx.actor.organizationId) {
      return apiError(new NotFoundError('Treasury account', body.treasuryAccountId), reqId);
    }
    if (!treasuryAccount.isActive) {
      return apiError(new ValidationError('Treasury account is not active'), reqId);
    }
    if (body.currencyCode !== treasuryAccount.currencyCode) {
      return apiError(
        new ValidationError(`Currency mismatch: treasury account uses ${treasuryAccount.currencyCode}, request uses ${body.currencyCode}`),
        reqId,
      );
    }

    const existing = await prisma.paymentSchedule.findUnique({
      where: { organizationId_code: { organizationId: ctx.actor.organizationId, code: body.code } },
      select: { id: true },
    });
    if (existing) {
      return apiError(new ConflictError('A payment schedule with this code already exists.'), reqId);
    }

    const currency = await prisma.currency.findUnique({
      where: { code: body.currencyCode },
      select: { code: true },
    });
    if (!currency) {
      return apiError(new NotFoundError('Currency', body.currencyCode), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: 'POST /api/v1/payment-schedules',
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
            const created = await tx.paymentSchedule.create({
              data: {
                organizationId: ctx.actor.organizationId!,
                code: body.code,
                treasuryAccountId: body.treasuryAccountId,
                description: body.description,
                amount: body.amount,
                currencyCode: body.currencyCode,
                frequency: body.frequency,
                nextDueDate: new Date(body.nextDueDate),
                endDate: body.endDate ? new Date(body.endDate) : null,
                status: 'SCHEDULED',
              },
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
                entityId: created.id,
                entityLabel: created.code,
                description: `Created payment schedule ${created.code}`,
                changes: {
                  code: { from: null, to: created.code },
                  treasuryAccountId: { from: null, to: created.treasuryAccountId },
                  amount: { from: null, to: created.amount },
                  currencyCode: { from: null, to: created.currencyCode },
                  frequency: { from: null, to: created.frequency },
                  nextDueDate: { from: null, to: created.nextDueDate.toISOString() },
                  endDate: { from: null, to: created.endDate?.toISOString() ?? null },
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