import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { writeAuditEntry } from '@/lib/audit/writer';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';
import { Prisma } from '@/generated/prisma/client';

const createAccessReviewSchema = z.object({
  name: z.string().min(1).max(200),
  periodStart: z.string().min(1),
  periodEnd: z.string().min(1),
  scopeJson: z.custom<Prisma.InputJsonValue | null>().optional(),
  userRoleIds: z.array(z.object({
    userId: z.string(),
    roleId: z.string(),
  })).min(1),
});

const updateAccessReviewSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  status: z.enum(['OPEN', 'IN_REVIEW', 'COMPLETED', 'CANCELLED']).optional(),
  summary: z.string().optional(),
});

export async function GET(
  request: NextRequest,
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'APPROVALS', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') || '20', 10)));
    const status = searchParams.get('status') || undefined;

    const where: Record<string, unknown> = { };
    if (status) where.status = status;

    const [reviews, total] = await Promise.all([
      prisma.accessReview.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          items: {
            include: {
              user: { select: { id: true, email: true, fullName: true } },
              role: { select: { id: true, code: true, name: true } },
            },
          },
        },
      }),
      prisma.accessReview.count({ where }),
    ]);

    return ok({ data: reviews, total, page, pageSize }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function POST(
  request: NextRequest,
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'APPROVALS', action: 'CONFIGURE' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const key = request.headers.get('idempotency-key');
    if (!key) {
      return apiError(new ValidationError('An Idempotency-Key header is required on this endpoint.'), reqId);
    }

    const orgId = ctx.actor.organizationId!;
    const body = createAccessReviewSchema.parse(await request.json());

    const periodStart = new Date(body.periodStart);
    const periodEnd = new Date(body.periodEnd);

    if (periodEnd <= periodStart) {
      return apiError(new ValidationError('periodEnd must be after periodStart'), reqId);
    }

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/access-reviews`,
      actorId: ctx.actor.userId,
      body: await request.json(),
      handler: async (tx) => {
        const review = await tx.accessReview.create({
          data: {
            name: body.name,
            periodStart,
            periodEnd,
            scopeJson: body.scopeJson ?? Prisma.JsonNull,
            status: 'OPEN',
            initiatedById: ctx.actor.userId,
            items: {
              create: body.userRoleIds.map((ur) => ({
                userId: ur.userId,
                roleId: ur.roleId,
              })),
            },
          },
          include: {
            items: {
              include: {
                user: { select: { id: true, email: true, fullName: true } },
                role: { select: { id: true, code: true, name: true } },
              },
            },
          },
        });

        await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, {
          action: 'ACCESS_REVIEW_COMPLETED',
          entityType: 'ACCESS_REVIEW',
          entityId: review.id,
          entityLabel: review.name,
          description: `Access review "${review.name}" created with ${review.items.length} items`,
          metadata: { periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString(), itemsCount: review.items.length },
          result: 'SUCCESS',
          channel: 'WEB',
        }, { organizationId: orgId, requestId: reqId });

        return { status: 201, body: review };
      },
    });

    if (outcome.kind === 'REPLAYED') {
      return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    }

    return ok(outcome.result, 201, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

