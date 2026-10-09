import { createHash } from 'node:crypto';
import { prisma } from '@/lib/db/prisma';
import { KernelError } from '@/lib/kernel/errors';
import type { Tx } from '@/lib/db/prisma';

/**
 * Idempotency (PHASE_1_PLAN.md 2.6).
 *
 * A double-click, a client retry, a proxy replay and a re-delivered offline
 * action must all produce exactly one financial effect. The key is claimed with a
 * conditional insert, so the database - not an application check - decides who
 * wins the race.
 *
 * A replayed request with the same key returns the ORIGINAL response rather than
 * an error, because the caller's intent (make this happen once) was satisfied. A
 * replayed request with the same key but a DIFFERENT body is a genuine conflict
 * and is rejected: that is almost always a bug, or an attempt to reuse a key to
 * smuggle in a different transaction.
 */

export interface IdempotencyRecord {
  id: string;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  responseStatus: number | null;
  responseBody: unknown;
}

export type IdempotencyOutcome<T> =
  | { kind: 'EXECUTED'; result: T }
  | { kind: 'REPLAYED'; responseStatus: number; responseBody: unknown };

function hashRequest(body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(body ?? null), 'utf8')
    .digest('hex');
}

export async function runIdempotent<T>(input: {
  key: string;
  scope: string;
  actorId: string | null;
  body: unknown;
  ttlSeconds?: number;
  handler: (tx: Tx) => Promise<{ status: number; body: T }>;
}): Promise<IdempotencyOutcome<T>> {
  const requestHash = hashRequest(input.body);
  const ttlSeconds = input.ttlSeconds ?? 86_400;

  // Claim the key. The unique constraint is the arbiter: a duplicate insert
  // loses the race and finds the winner's row.
  let claimed = false;
  try {
    await prisma.idempotencyKey.create({
      data: {
        key: input.key,
        scope: input.scope,
        actorId: input.actorId,
        requestHash,
        status: 'IN_PROGRESS',
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      },
    });
    claimed = true;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }

  if (!claimed) {
    const existing = await prisma.idempotencyKey.findUnique({
      where: { key_scope: { key: input.key, scope: input.scope } },
    });

    if (!existing) {
      // Lost the race and the winner vanished in between. Treated as a conflict
      // rather than silently executing, which could double-apply the effect.
      throw new KernelError(
        'IDEMPOTENCY_CONFLICT',
        'This request key is being processed. Retry shortly.',
        {
          retryable: true,
        },
      );
    }

    if (existing.requestHash !== requestHash) {
      throw new KernelError(
        'IDEMPOTENCY_CONFLICT',
        'This request key has already been used with a different payload.',
        { details: { key: input.key, scope: input.scope } },
      );
    }

    if (existing.status === 'COMPLETED') {
      return {
        kind: 'REPLAYED',
        responseStatus: existing.responseStatus ?? 200,
        responseBody: existing.responseBody,
      };
    }

    if (existing.status === 'IN_PROGRESS') {
      throw new KernelError('IDEMPOTENCY_CONFLICT', 'This request is still in progress.', {
        retryable: true,
      });
    }

    // FAILED: the previous attempt did not commit its effect, so allow a retry.
    await prisma.idempotencyKey.update({
      where: { key_scope: { key: input.key, scope: input.scope } },
      data: { status: 'IN_PROGRESS', requestHash },
    });
  }

  try {
    const result = await input.handler(prisma as unknown as Tx);

    await prisma.idempotencyKey.update({
      where: { key_scope: { key: input.key, scope: input.scope } },
      data: {
        status: 'COMPLETED',
        responseStatus: result.status,
        responseBody: result.body as never,
        completedAt: new Date(),
      },
    });

    return { kind: 'EXECUTED', result: result.body };
  } catch (error) {
    await prisma.idempotencyKey.updateMany({
      where: { key: input.key, scope: input.scope, status: 'IN_PROGRESS' },
      data: { status: 'FAILED', completedAt: new Date() },
    });
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  );
}
