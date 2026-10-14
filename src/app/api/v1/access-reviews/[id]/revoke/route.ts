import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { writeAuditEntry } from '@/lib/audit/writer';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';

const revokeSchema = z.object({
  items: z.array(z.object({
    itemId: z.string(),
    decision: z.literal('REVOKE'),
    reason: z.string().optional(),
  })).min(1),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'APPROVALS', action: 'REJECT' });

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
      include: { items: true },
    });

    if (!existingReview) {
      return apiError(new NotFoundError('AccessReview', id), reqId);
    }

    if (existingReview.status !== 'OPEN' && existingReview.status !== 'IN_REVIEW') {
      return apiError(new ValidationError(`Cannot revoke items in ${existingReview.status} review`), reqId);
    }

    const body = revokeSchema.parse(await request.json());

    const itemIds = body.items.map((i) => i.itemId);
    const reviewItems = await prisma.accessReviewItem.findMany({
      where: { id: { in: itemIds }, reviewId: id },
    });

    if (reviewItems.length !== itemIds.length) {
      return apiError(new ValidationError('Some items not found in this review'), reqId);
    }

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/access-reviews/${id}/revoke`,
      actorId: ctx.actor.userId,
      body: await request.json(),
      handler: async (tx) => {
        for (const itemInput of body.items) {
          await tx.accessReviewItem.update({
            where: { id: itemInput.itemId },
            data: {
              decision: 'REVOKE',
              decisionReason: itemInput.reason,
              decidedById: ctx.actor.userId,
              decidedAt: new Date(),
              actionedAt: new Date(),
            },
          });

          const item = reviewItems.find((i) => i.id === itemInput.itemId);
          if (item) {
            await tx.userRole.updateMany({
              where: { userId: item.userId, roleId: item.roleId, revokedAt: null },
              data: { revokedAt: new Date() },
            });
          }
        }

        const allItems = await tx.accessReviewItem.findMany({ where: { reviewId: id } });
        const allDecided = allItems.every((item) => item.decision);

        if (allDecided) {
          await tx.accessReview.update({
            where: { id },
            data: { status: 'COMPLETED', completedAt: new Date() },
          });
        } else {
          await tx.accessReview.update({
            where: { id },
            data: { status: 'IN_REVIEW' },
          });
        }

        await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, {
          action: 'ACCESS_REVIEW_COMPLETED',
          entityType: 'ACCESS_REVIEW',
          entityId: id,
          entityLabel: existingReview.name,
          description: `Revoked ${body.items.length} access review items`,
          metadata: { itemsCount: body.items.length, allDecided, revoked: true },
          result: 'SUCCESS',
          channel: 'WEB',
        }, { organizationId: ctx.actor.organizationId, requestId: reqId });

        return { status: 200, body: { revokedCount: body.items.length, allDecided, reviewStatus: allDecided ? 'COMPLETED' : 'IN_REVIEW' } };
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