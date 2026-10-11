import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { writeAuditEntry } from '@/lib/audit/writer';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';

const updateAccessReviewSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  status: z.enum(['OPEN', 'IN_REVIEW', 'COMPLETED', 'CANCELLED']).optional(),
  summary: z.string().optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ organizationId: string; id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'APPROVALS', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const { id } = await params;

    const review = await prisma.accessReview.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            user: { select: { id: true, email: true, fullName: true } },
            role: { select: { id: true, code: true, name: true } },
          },
        },
      },
    });

    if (!review) {
      return apiError(new NotFoundError('AccessReview', id), reqId);
    }

    return ok(review, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ organizationId: string; id: string }> },
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

    const { id } = await params;

    const existingReview = await prisma.accessReview.findUnique({
      where: { id },
    });

    if (!existingReview) {
      return apiError(new NotFoundError('AccessReview', id), reqId);
    }

    const body = updateAccessReviewSchema.parse(await request.json());

    const updateData: Record<string, unknown> = {};
    if (body.name !== undefined) updateData.name = body.name;
    if (body.status !== undefined) updateData.status = body.status;
    if (body.summary !== undefined) updateData.summary = body.summary;
    if (body.status === 'COMPLETED' && existingReview.status !== 'COMPLETED') {
      updateData.completedAt = new Date();
    }

    const outcome = await runIdempotent({
      key,
      scope: `PUT /api/v1/access-reviews/${id}`,
      actorId: ctx.actor.userId,
      body: await request.json(),
      handler: async (tx) => {
        const review = await tx.accessReview.update({
          where: { id },
          data: updateData,
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
          description: `Access review "${review.name}" updated`,
          changes: {
            status: { from: existingReview.status, to: review.status },
            name: { from: existingReview.name, to: review.name },
          },
          result: 'SUCCESS',
          channel: 'WEB',
        }, { organizationId: ctx.actor.organizationId, requestId: reqId });

        return { status: 200, body: review };
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

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ organizationId: string; id: string }> },
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

    const { id } = await params;

    const existingReview = await prisma.accessReview.findUnique({
      where: { id },
    });

    if (!existingReview) {
      return apiError(new NotFoundError('AccessReview', id), reqId);
    }

    const outcome = await runIdempotent({
      key,
      scope: `DELETE /api/v1/access-reviews/${id}`,
      actorId: ctx.actor.userId,
      body: {},
      handler: async (tx) => {
        await tx.accessReviewItem.deleteMany({ where: { reviewId: id } });
        await tx.accessReview.delete({ where: { id } });

        await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, {
          action: 'ACCESS_REVIEW_COMPLETED',
          entityType: 'ACCESS_REVIEW',
          entityId: id,
          entityLabel: existingReview.name,
          description: `Access review "${existingReview.name}" deleted`,
          result: 'SUCCESS',
          channel: 'WEB',
        }, { organizationId: ctx.actor.organizationId, requestId: reqId });

        return { status: 204, body: null };
      },
    });

    if (outcome.kind === 'REPLAYED') {
      return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    }

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiError(error, reqId);
  }
}