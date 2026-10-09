import { prisma } from '@/lib/db/prisma';
import { computeEntryHash, computeSignature, GENESIS_HASH } from '@/lib/audit/chain';
import { SYSTEM_ACTOR } from '@/lib/audit/writer';
import { recordAuditEvent } from '@/lib/db/with-audit';
import { timingSafeEqual } from '@/lib/crypto';

/**
 * Chain verification (PHASE_1_PLAN.md 7.3.4).
 *
 * Recomputes every entry hash from the stored fields and re-derives every
 * signature. It does NOT trust the stored entry_hash: trusting it would mean
 * detecting only link breaks, not content tampering.
 *
 * A BROKEN checkpoint raises a CRITICAL SecurityEvent and notifies the CEO. It
 * never repairs anything. The audit trail is evidence; silently "fixing" a break
 * destroys exactly what the break is evidence of.
 */

export interface ChainVerificationResult {
  fromSequence: bigint;
  toSequence: bigint;
  entriesChecked: number;
  status: 'VERIFIED' | 'BROKEN';
  brokenAtSequence: bigint | null;
  detail: string | null;
}

/** Verify from a starting sequence to the current head. */
export async function verifyChain(options: {
  fromSequence?: bigint;
  toSequence?: bigint;
  verifySignatures?: boolean;
}): Promise<ChainVerificationResult> {
  const head = await prisma.auditChainHead.findUnique({ where: { id: 1 } });
  if (!head) {
    return {
      fromSequence: 0n,
      toSequence: 0n,
      entriesChecked: 0,
      status: 'BROKEN',
      brokenAtSequence: 0n,
      detail: 'audit_chain_head row is missing',
    };
  }

  const fromSequence = options.fromSequence ?? 0n;
  const toSequence = options.toSequence ?? head.sequence;

  let previousHash = fromSequence === 0n ? GENESIS_HASH : null;

  if (fromSequence > 0n) {
    const prior = await prisma.auditLog.findUnique({
      where: { sequence: fromSequence - 1n },
      select: { entryHash: true },
    });
    previousHash = prior?.entryHash ?? null;
    if (previousHash === null) {
      return {
        fromSequence,
        toSequence,
        entriesChecked: 0,
        status: 'BROKEN',
        brokenAtSequence: fromSequence - 1n,
        detail: `entry ${fromSequence - 1n} is missing; verification cannot start from a known anchor`,
      };
    }
  }

  let entriesChecked = 0;

  const entries = await prisma.auditLog.findMany({
    where: { sequence: { gte: fromSequence, lte: toSequence } },
    orderBy: { sequence: 'asc' },
    select: {
      sequence: true,
      previousHash: true,
      entryHash: true,
      signature: true,
      actorId: true,
      action: true,
      entityType: true,
      entityId: true,
      description: true,
      changes: true,
      occurredAt: true,
    },
  });

  for (const entry of entries) {
    const expectedPrevious = previousHash ?? GENESIS_HASH;

    if ((entry.previousHash ?? GENESIS_HASH) !== expectedPrevious) {
      return {
        fromSequence,
        toSequence,
        entriesChecked,
        status: 'BROKEN',
        brokenAtSequence: entry.sequence,
        detail: `entry ${entry.sequence} does not link to the preceding entry`,
      };
    }

    const recomputed = computeEntryHash({
      sequence: entry.sequence,
      previousHash: expectedPrevious,
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      description: entry.description,
      changes: entry.changes,
      occurredAt: entry.occurredAt,
    });

    if (recomputed !== entry.entryHash) {
      return {
        fromSequence,
        toSequence,
        entriesChecked,
        status: 'BROKEN',
        brokenAtSequence: entry.sequence,
        detail: `entry ${entry.sequence} content does not match its hash: a field was altered after the entry was written`,
      };
    }

    if (options.verifySignatures !== false) {
      const expectedSignature = computeSignature(entry.entryHash);
      if (!timingSafeEqual(expectedSignature, entry.signature)) {
        return {
          fromSequence,
          toSequence,
          entriesChecked,
          status: 'BROKEN',
          brokenAtSequence: entry.sequence,
          detail: `entry ${entry.sequence} has an invalid signature: it was not produced by this system's HMAC key`,
        };
      }
    }

    previousHash = entry.entryHash;
    entriesChecked += 1;
  }

  if (toSequence === head.sequence && previousHash !== head.entryHash) {
    return {
      fromSequence,
      toSequence,
      entriesChecked,
      status: 'BROKEN',
      brokenAtSequence: head.sequence,
      detail: 'chain head does not match the last stored entry',
    };
  }

  return {
    fromSequence,
    toSequence,
    entriesChecked,
    status: 'VERIFIED',
    brokenAtSequence: null,
    detail: null,
  };
}

/**
 * Seal a period and verify it.
 *
 * Checkpoints make verification incremental: each night we verify from the last
 * seal forward rather than replaying the whole history.
 */
export async function sealAndVerifyPeriod(input: {
  periodStart: Date;
  periodEnd: Date;
  initiatedById?: string | null;
}): Promise<{ checkpointId: string; result: ChainVerificationResult }> {
  const head = await prisma.auditChainHead.findUnique({ where: { id: 1 } });
  if (!head) throw new Error('audit_chain_head is missing');

  const lastVerified = await prisma.auditChainCheckpoint.findFirst({
    where: { status: 'VERIFIED' },
    orderBy: { sealedThroughSequence: 'desc' },
    select: { sealedThroughSequence: true, sealedEntryHash: true },
  });

  const fromSequence = lastVerified ? lastVerified.sealedThroughSequence : 0n;
  const result = await verifyChain({ fromSequence, toSequence: head.sequence });

  const anchor =
    result.status === 'VERIFIED'
      ? await prisma.auditLog.findUnique({
          where: { sequence: head.sequence },
          select: { entryHash: true },
        })
      : null;

  const checkpoint = await prisma.auditChainCheckpoint.create({
    data: {
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      sealedThroughSequence: head.sequence,
      sealedEntryHash: anchor?.entryHash ?? '',
      status: result.status,
      verifiedAt: result.status === 'VERIFIED' ? new Date() : null,
      entriesChecked: result.entriesChecked,
      brokenAtSequence: result.brokenAtSequence,
      detail: result.detail,
    },
    select: { id: true },
  });

  await recordAuditEvent(
    { actor: SYSTEM_ACTOR, requestId: `audit-seal:${checkpoint.id}` },
    {
      action: 'SECURITY_EVENT',
      entityType: 'AUDIT_LOG',
      entityId: checkpoint.id,
      entityLabel: `Audit chain seal through sequence ${head.sequence.toString()}`,
      description:
        result.status === 'VERIFIED'
          ? `Audit chain verified: ${result.entriesChecked} entries from sequence ${fromSequence.toString()} to ${head.sequence.toString()}`
          : `AUDIT CHAIN BROKEN at sequence ${result.brokenAtSequence?.toString()}: ${result.detail}`,
      result: result.status === 'VERIFIED' ? 'SUCCESS' : 'FAILURE',
      securityEvent:
        result.status === 'VERIFIED'
          ? {
              type: 'AUDIT_CHAIN_VERIFIED',
              severity: 'INFO',
              description: `Verified ${result.entriesChecked} audit entries through sequence ${head.sequence.toString()}.`,
            }
          : {
              type: 'AUDIT_CHAIN_BROKEN',
              severity: 'CRITICAL',
              subjectType: 'AUDIT_LOG',
              subjectId: checkpoint.id,
              description:
                `The append-only audit chain failed verification at sequence ` +
                `${result.brokenAtSequence?.toString()}. ${result.detail ?? ''}`.trim(),
              detail: { ...result },
            },
    },
  );

  return { checkpointId: checkpoint.id, result };
}
