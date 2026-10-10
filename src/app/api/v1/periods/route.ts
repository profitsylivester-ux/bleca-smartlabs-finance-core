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
import { ConflictError, ValidationError } from '@/lib/kernel/errors';

const periodTypeSchema = z.enum(['MONTHLY', 'QUARTERLY', 'ANNUAL']);
const periodStatusSchema = z.enum(['OPEN', 'CLOSING', 'CLOSED', 'LOCKED', 'REOPEN_PENDING', 'REOPENED']);

const createSchema = z.object({
  type: periodTypeSchema,
  code: z.string().min(2).max(50).toUpperCase(),
  name: z.string().min(2).max(120),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  isAdjustment: z.boolean().optional(),
});

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

function validatePeriodDates(type: string, startDate: Date, endDate: Date): string | null {
  if (startDate >= endDate) {
    return 'Start date must be before end date';
  }

  const start = new Date(startDate);
  const end = new Date(endDate);

  switch (type) {
    case 'MONTHLY': {
      const diffMonths = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
      if (diffMonths !== 1 || start.getDate() !== 1 || end.getDate() !== new Date(end.getFullYear(), end.getMonth() + 1, 0).getDate()) {
        return 'Monthly period must span exactly one calendar month';
      }
      break;
    }
    case 'QUARTERLY': {
      const startQuarter = Math.floor(start.getMonth() / 3);
      const endQuarter = Math.floor(end.getMonth() / 3);
      if (startQuarter !== endQuarter || start.getMonth() % 3 !== 0 || end.getDate() !== new Date(end.getFullYear(), end.getMonth() + 1, 0).getDate()) {
        return 'Quarterly period must span exactly one calendar quarter';
      }
      break;
    }
    case 'ANNUAL': {
      if (start.getMonth() !== 0 || start.getDate() !== 1 || end.getMonth() !== 11 || end.getDate() !== 31) {
        return 'Annual period must span the full calendar year';
      }
      break;
    }
  }
  return null;
}

export async function GET() {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'MASTER_DATA', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const periods = await prisma.financialPeriod.findMany({
      where: { organizationId: ctx.actor.organizationId },
      orderBy: [{ type: 'asc' }, { startDate: 'asc' }],
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

    return ok({ data: periods, count: periods.length }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function POST(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'MASTER_DATA', action: 'CREATE' });

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

    const startDate = new Date(body.startDate);
    const endDate = new Date(body.endDate);

    const dateError = validatePeriodDates(body.type, startDate, endDate);
    if (dateError) {
      return apiError(new ValidationError(dateError), reqId);
    }

    const existing = await prisma.financialPeriod.findUnique({
      where: { organizationId_code: { organizationId: ctx.actor.organizationId, code: body.code } },
      select: { id: true },
    });
    if (existing) {
      return apiError(new ConflictError('A period with this code already exists.'), reqId);
    }

    const overlapping = await prisma.financialPeriod.findFirst({
      where: {
        organizationId: ctx.actor.organizationId,
        type: body.type,
        OR: [
          { startDate: { lte: endDate }, endDate: { gte: startDate } },
        ],
      },
      select: { id: true },
    });
    if (overlapping) {
      return apiError(new ConflictError('Period overlaps with an existing period of the same type.'), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: 'POST /api/v1/periods',
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
            const created = await tx.financialPeriod.create({
              data: {
                organizationId: ctx.actor.organizationId!,
                type: body.type,
                status: 'OPEN',
                code: body.code,
                name: body.name,
                startDate,
                endDate,
                isAdjustment: body.isAdjustment ?? false,
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
                action: 'CONFIGURATION_CHANGES',
                entityType: 'FINANCIAL_PERIOD',
                entityId: created.id,
                entityLabel: created.code,
                description: `Created financial period ${created.code} (${created.name})`,
                changes: {
                  type: { from: null, to: created.type },
                  code: { from: null, to: created.code },
                  name: { from: null, to: created.name },
                  startDate: { from: null, to: created.startDate.toISOString() },
                  endDate: { from: null, to: created.endDate.toISOString() },
                  status: { from: null, to: created.status },
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