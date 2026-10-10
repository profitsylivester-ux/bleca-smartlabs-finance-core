import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { withAudit } from '@/lib/db/with-audit';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';
import { TransactionService } from '@/lib/transactions/service';

const service = new TransactionService();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ organizationId: string; id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'TRANSACTIONS', action: 'POST' });

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

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/transactions/${id}/post`,
      actorId: ctx.actor.userId,
      body: {},
      handler: async (tx) => {
        const result = await service._doAction(tx, id, ctx.actor.organizationId, ctx.actor, 'POSTED');
        return { status: 200, body: result };
      },
    });

    if (outcome.kind === 'REPLAYED') {
      return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    }

    return ok(outcome.result, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}