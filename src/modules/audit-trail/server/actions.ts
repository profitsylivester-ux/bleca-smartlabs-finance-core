'use server';

import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { verifyChain, sealAndVerifyPeriod } from '@/lib/audit/verifier';
import { headers } from 'next/headers';
import { randomUUID } from 'node:crypto';

/**
 * Audit trail actions.
 *
 * The chain verification action lives HERE rather than in users-roles, because it
 * is an audit-trail concern. That placement is not cosmetic: src/tests/unit/
 * import-graph.test.ts asserts that no module imports another module's internals,
 * and the first draft of this file did exactly that.
 */

export interface ActionResult {
  ok: boolean;
  message?: string;
  data?: Record<string, unknown>;
}

/**
 * Verifies the whole chain on demand.
 *
 * Recomputes every entry hash from its stored fields and re-derives every
 * signature. That is O(history), so it is a button rather than something on every
 * page render - but it must be available on demand, because "we could verify it"
 * is a different claim from "we did".
 *
 * A break is reported, never repaired. The break is the evidence; silently
 * rewriting the chain would destroy exactly what it demonstrates.
 */
export async function verifyAuditChainAction(): Promise<ActionResult> {
  const ctx = await requireContext();
  await authorize(ctx, { module: 'AUDIT_TRAIL', action: 'ADMINISTER' });

  const result = await verifyChain({});

  if (result.status === 'VERIFIED') {
    return {
      ok: true,
      message: `Chain verified across ${result.entriesChecked} entries (sequence ${result.fromSequence.toString()} to ${result.toSequence.toString()}).`,
      data: {
        status: 'VERIFIED',
        entriesChecked: result.entriesChecked,
        fromSequence: result.fromSequence.toString(),
        toSequence: result.toSequence.toString(),
      },
    };
  }

  return {
    ok: false,
    message: `CHAIN BROKEN at sequence ${result.brokenAtSequence?.toString() ?? 'unknown'}: ${result.detail}`,
    data: {
      status: 'BROKEN',
      brokenAtSequence: result.brokenAtSequence?.toString() ?? null,
      detail: result.detail,
    },
  };
}

/**
 * Seals a period and verifies incrementally from the last good checkpoint.
 *
 * Daily seals mean verification does not have to replay the entire history every
 * night: it resumes from the previous seal.
 */
export async function sealChainAction(formData: FormData): Promise<ActionResult> {
  const ctx = await requireContext();
  await authorize(ctx, { module: 'AUDIT_TRAIL', action: 'ADMINISTER' });

  const now = new Date();
  const periodStartInput = String(formData.get('periodStart') ?? '');
  const periodEndInput = String(formData.get('periodEnd') ?? '');

  const periodStart = periodStartInput ? new Date(periodStartInput) : now;
  const periodEnd = periodEndInput ? new Date(periodEndInput) : now;

  if (periodEnd.getTime() < periodStart.getTime()) {
    return { ok: false, message: 'The seal period must end after it starts.' };
  }

  const h = await headers();
  const requestId = h.get('x-request-id') ?? randomUUID();

  const { checkpointId, result } = await sealAndVerifyPeriod({
    periodStart,
    periodEnd,
    initiatedById: ctx.actor.userId,
  });

  void requestId;

  return {
    ok: result.status === 'VERIFIED',
    message:
      result.status === 'VERIFIED'
        ? `Sealed and verified ${result.entriesChecked} entries through sequence ${result.toSequence.toString()}.`
        : `Seal recorded, but verification FAILED at sequence ${result.brokenAtSequence?.toString()}. A CRITICAL security event has been raised.`,
    data: { checkpointId, ...result, toSequence: result.toSequence.toString() },
  };
}

export async function listChainCheckpoints(limit = 30) {
  const ctx = await requireContext();
  await authorize(ctx, { module: 'AUDIT_TRAIL', action: 'VIEW' });

  return prisma.auditChainCheckpoint.findMany({
    orderBy: { sealedAt: 'desc' },
    take: Math.min(100, Math.max(1, limit)),
    select: {
      id: true,
      periodStart: true,
      periodEnd: true,
      sealedThroughSequence: true,
      sealedEntryHash: true,
      sealedAt: true,
      verifiedAt: true,
      status: true,
      entriesChecked: true,
      brokenAtSequence: true,
      detail: true,
    },
  });
}
