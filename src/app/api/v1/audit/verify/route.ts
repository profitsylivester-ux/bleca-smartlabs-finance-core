import { NextResponse } from 'next/server';
import { z } from 'zod';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { authorize } from '@/lib/kernel/authorize';
import { verifyChain } from '@/lib/audit/verifier';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';

/**
 * /api/v1/audit/verify
 *
 * POST, not GET: verification re-derives every entry hash and signature over the
 * whole history, and it is a read that consumes real CPU. Making it a mutating
 * verb keeps it out of prefetchers, crawlers and browser address bars.
 */

export async function POST() {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'AUDIT_TRAIL', action: 'ADMINISTER' });

    const result = await verifyChain({});

    if (result.status === 'VERIFIED') {
      return ok(
        {
          data: {
            status: 'VERIFIED',
            entriesChecked: result.entriesChecked,
            fromSequence: result.fromSequence.toString(),
            toSequence: result.toSequence.toString(),
          },
        },
        200,
        reqId,
      );
    }

    return NextResponse.json(
      {
        error: {
          code: 'CHAIN_BROKEN',
          message:
            'The audit chain failed verification. This is reported, never repaired: a break is itself the evidence.',
          details: {
            brokenAtSequence: result.brokenAtSequence?.toString() ?? null,
            detail: result.detail,
            requestId: reqId,
          },
        },
      },
      { status: 409 },
    );
  } catch (error) {
    return apiError(error, reqId);
  }
}

const schema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(500),
});

/**
 * Confirms that specific records have an audit trail.
 *
 * This is what makes "every shilling must have a permanent traceable record"
 * (BUILD_PROMPT.md section 4) checkable by a third party: hand it a list of
 * record ids and it answers whether each one has history.
 */
export async function PUT(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'AUDIT_TRAIL', action: 'VIEW' });

    const { ids } = schema.parse(await request.json());

    const counts = await prisma.auditLog.groupBy({
      by: ['entityId'],
      where: { entityId: { in: ids } },
      _count: { entityId: true },
    });

    const withHistory = new Map(counts.map((c) => [c.entityId, c._count.entityId]));
    const result = ids.map((id) => ({ entityId: id, auditEntries: withHistory.get(id) ?? 0 }));
    const untraced = result.filter((r) => r.auditEntries === 0);

    return ok(
      {
        data: result,
        summary: {
          checked: ids.length,
          traced: ids.length - untraced.length,
          untraced: untraced.map((r) => r.entityId),
        },
      },
      200,
      reqId,
    );
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function GET() {
  const reqId = await requestId();
  return apiError(
    new ValidationError(
      'Use POST to verify the chain, or PUT with {"ids": [...]} to check traceability.',
    ),
    reqId,
  );
}

void headers;
void prisma;
void NotFoundError;
