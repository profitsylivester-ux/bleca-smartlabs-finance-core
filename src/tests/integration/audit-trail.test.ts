import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { writeAuditEntry, SYSTEM_ACTOR } from '@/lib/audit/writer';
import { verifyChain } from '@/lib/audit/verifier';

/**
 * The database-level audit guarantees.
 *
 * These tests exist because PHASE_1_PLAN.md 7.3 promises four things that a
 * TypeScript type system cannot enforce and a service layer cannot be trusted to
 * enforce:
 *
 *   1. audit_logs is append-only
 *   2. an entry must chain from the current head
 *   3. a gap in the chain cannot be papered over
 *   4. the whole chain is verifiable afterwards
 *
 * Every test below attempts the violation directly with raw SQL - the position an
 * attacker with a leaked database credential would be in. If a service-layer bug
 * or an injection slips through, the database still refuses.
 */

const actor = { id: null, name: 'integration-test', roleCodes: ['SYSTEM'] };

async function audit(
  tx: Parameters<typeof writeAuditEntry>[0],
  description: string,
  overrides: Partial<Parameters<typeof writeAuditEntry>[2]> = {},
): Promise<void> {
  await writeAuditEntry(
    tx,
    actor,
    {
      action: 'SYSTEM',
      entityType: 'SYSTEM',
      description,
      ...overrides,
    },
    {},
  );
}

async function currentHead(): Promise<{ sequence: bigint; entryHash: string }> {
  const head = await prisma.auditChainHead.findUnique({ where: { id: 1 } });
  if (!head) throw new Error('audit_chain_head missing');
  return head;
}

beforeAll(async () => {
  /**
   * These tests need at least one real entry to attempt to alter, and it is
   * written through the application writer so the entry is properly hashed and
   * linked.
   *
   * The assertion is relative, not absolute: the suite runs against a freshly
   * reset database, but the audit chain is global and the other integration
   * files legitimately write entries too, so "this added exactly one" is the
   * property that matters rather than "this is entry number one".
   */
  const before = await currentHead();

  await prisma.$transaction(async (tx) => {
    await audit(tx, 'integration: genesis entry');
  });

  const after = await currentHead();
  expect(after.sequence).toBe(before.sequence + 1n);
});

describe('audit_logs append-only enforcement', () => {
  it('refuses UPDATE on an existing entry', async () => {
    const before = await prisma.auditLog.count();

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE audit_logs SET description = 'tampered' WHERE sequence = (SELECT MIN(sequence) FROM audit_logs)`,
      ),
    ).rejects.toThrow(/append-only/i);

    expect(await prisma.auditLog.count()).toBe(before);
  });

  it('refuses DELETE on an existing entry', async () => {
    const before = await prisma.auditLog.count();

    await expect(
      prisma.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE sequence = (SELECT MIN(sequence) FROM audit_logs)`,
      ),
    ).rejects.toThrow(/append-only/i);

    expect(await prisma.auditLog.count()).toBe(before);
  });

  /**
   * Postgres refuses TRUNCATE on a table referenced by a foreign key before any
   * trigger runs, so in this schema the FK blocks it and the trigger is the
   * backstop for the case where those keys are dropped. Either refusal is a
   * refusal; what matters is that all rows survive.
   */
  it('refuses TRUNCATE, which a row-level trigger pair would otherwise miss', async () => {
    const before = await prisma.auditLog.count();

    await expect(prisma.$executeRawUnsafe(`TRUNCATE TABLE audit_logs`)).rejects.toThrow();

    expect(await prisma.auditLog.count()).toBe(before);
    expect(before).toBeGreaterThan(0);
  });

  it('refuses the mutation through the ORM as well as raw SQL', async () => {
    const entry = await prisma.auditLog.findFirst({ orderBy: { sequence: 'asc' } });
    expect(entry).not.toBeNull();

    await expect(
      prisma.auditLog.update({
        where: { sequence: entry!.sequence },
        data: { description: 'tampered via ORM' },
      }),
    ).rejects.toThrow();

    const unchanged = await prisma.auditLog.findUnique({
      where: { sequence: entry!.sequence },
      select: { description: true },
    });
    expect(unchanged?.description).toBe(entry!.description);
  });
});

describe('audit chain linkage', () => {
  it('refuses an entry that does not chain from the current head', async () => {
    const head = await currentHead();
    const wrongPrevious = 'f'.repeat(64);

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO audit_logs
           (id, organization_id, sequence, previous_hash, entry_hash, signature, action, entity_type,
            description, occurred_at, recorded_at, channel, result, actor_name, actor_role_codes,
            signature_key_version)
         VALUES ('forged-1', NULL, ${head.sequence + 1n}, '${wrongPrevious}', repeat('a', 64),
                 repeat('b', 64), 'SYSTEM', 'SYSTEM', 'forged', now(), now(), 'SYSTEM', 'SUCCESS',
                 'attacker', '{}', 1)`,
      ),
    ).rejects.toThrow(/chain link mismatch/i);
  });

  it('refuses an entry that skips a sequence number', async () => {
    const head = await currentHead();

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO audit_logs
           (id, organization_id, sequence, previous_hash, entry_hash, signature, action, entity_type,
            description, occurred_at, recorded_at, channel, result, actor_name, actor_role_codes,
            signature_key_version)
         VALUES ('gap-1', NULL, ${head.sequence + 5n}, '${head.entryHash}', repeat('a', 64),
                 repeat('b', 64), 'SYSTEM', 'SYSTEM', 'gap entry', now(), now(), 'SYSTEM', 'SUCCESS',
                 'attacker', '{}', 1)`,
      ),
    ).rejects.toThrow(/sequence gap/i);
  });

  /**
   * The important half of "gap-detected": even someone who has deleted a row and
   * holds the HMAC key cannot insert a replacement, because the sequence must
   * continue from the head rather than backfilling the hole.
   */
  it('refuses to backfill a hole created by deleting an entry', async () => {
    const head = await currentHead();

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO audit_logs
           (id, organization_id, sequence, previous_hash, entry_hash, signature, action, entity_type,
            description, occurred_at, recorded_at, channel, result, actor_name, actor_role_codes,
            signature_key_version)
         VALUES ('backfill-1', NULL, ${head.sequence + 2n}, repeat('c', 64), repeat('a', 64),
                 repeat('b', 64), 'SYSTEM', 'SYSTEM', 'backfill attempt', now(), now(), 'SYSTEM',
                 'SUCCESS', 'attacker', '{}', 1)`,
      ),
    ).rejects.toThrow(/audit chain/i);
  });

  it('refuses a malformed entry hash', async () => {
    const head = await currentHead();

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO audit_logs
           (id, organization_id, sequence, previous_hash, entry_hash, signature, action, entity_type,
            description, occurred_at, recorded_at, channel, result, actor_name, actor_role_codes,
            signature_key_version)
         VALUES ('badhash-1', NULL, ${head.sequence + 1n}, '${head.entryHash}', 'NOT-A-HASH',
                 repeat('b', 64), 'SYSTEM', 'SYSTEM', 'bad hash', now(), now(), 'SYSTEM', 'SUCCESS',
                 'attacker', '{}', 1)`,
      ),
    ).rejects.toThrow(/64 lowercase hex/i);
  });

  it('refuses an unsigned entry', async () => {
    const head = await currentHead();

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO audit_logs
           (id, organization_id, sequence, previous_hash, entry_hash, signature, action, entity_type,
            description, occurred_at, recorded_at, channel, result, actor_name, actor_role_codes,
            signature_key_version)
         VALUES ('unsigned-1', NULL, ${head.sequence + 1n}, '${head.entryHash}', repeat('a', 64),
                 'short', 'SYSTEM', 'SYSTEM', 'unsigned', now(), now(), 'SYSTEM', 'SUCCESS',
                 'attacker', '{}', 1)`,
      ),
    ).rejects.toThrow(/signature/i);
  });

  it('refuses an entry with no description', async () => {
    const head = await currentHead();

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO audit_logs
           (id, organization_id, sequence, previous_hash, entry_hash, signature, action, entity_type,
            description, occurred_at, recorded_at, channel, result, actor_name, actor_role_codes,
            signature_key_version)
         VALUES ('nodesc-1', NULL, ${head.sequence + 1n}, '${head.entryHash}', repeat('a', 64),
                 repeat('b', 64), 'SYSTEM', 'SYSTEM', '   ', now(), now(), 'SYSTEM', 'SUCCESS',
                 'attacker', '{}', 1)`,
      ),
    ).rejects.toThrow(/description/i);
  });
});

describe('chain writer and verifier', () => {
  it('advances the head and links each entry', async () => {
    const before = await currentHead();

    await prisma.$transaction(async (tx) => {
      await audit(tx, 'integration: first');
      await audit(tx, 'integration: second');
    });

    const entries = await prisma.auditLog.findMany({
      orderBy: { sequence: 'desc' },
      take: 2,
      select: { sequence: true, previousHash: true },
    });

    expect(entries[0]!.sequence).toBe(before.sequence + 2n);
    expect(entries[1]!.sequence).toBe(before.sequence + 1n);
    expect(entries[1]!.previousHash).toBe(before.entryHash);
  });

  it('verifies a chain that was written through the application', async () => {
    const result = await verifyChain({});

    expect(result.status).toBe('VERIFIED');
    expect(result.detail).toBeNull();
    expect(result.entriesChecked).toBeGreaterThan(0);
  });

  it('rolls the head back when the surrounding transaction fails', async () => {
    /**
     * The reason the head lives inside the same transaction as the entry. If the
     * head advanced outside it, a rolled-back write would consume a sequence
     * number and leave a permanent, unfillable hole in the chain.
     */
    const before = await currentHead();

    await expect(
      prisma.$transaction(async (tx) => {
        await audit(tx, 'integration: will be rolled back');
        throw new Error('deliberate failure after the audit write');
      }),
    ).rejects.toThrow(/deliberate failure/);

    const after = await currentHead();
    expect(after.sequence).toBe(before.sequence);
    expect(after.entryHash).toBe(before.entryHash);

    const orphan = await prisma.auditLog.findFirst({
      where: { description: 'integration: will be rolled back' },
    });
    expect(orphan).toBeNull();
  });

  it('detects content tampering that bypassed the trigger', async () => {
    /**
     * Simulates the one attack the trigger cannot catch: someone who disabled the
     * trigger, edited a stored field, and re-enabled it. The hash chain is what
     * catches this, which is exactly why it exists alongside the trigger.
     */
    const before = await verifyChain({});
    expect(before.status).toBe('VERIFIED');

    const head = await currentHead();
    const target = await prisma.auditLog.findFirst({
      where: { sequence: { lte: head.sequence } },
      orderBy: { sequence: 'desc' },
      select: { id: true, sequence: true },
    });
    expect(target).not.toBeNull();

    await prisma.$executeRawUnsafe(`ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_update`);
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE audit_logs SET description = 'edited after the fact' WHERE sequence = ${target!.sequence}`,
      );
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_update`);
    }

    const after = await verifyChain({});
    expect(after.status).toBe('BROKEN');
    expect(after.brokenAtSequence).toBe(target!.sequence);
    expect(after.detail).toMatch(/does not match its hash/);
  });
});

describe('security events', () => {
  it('records an event alongside its audit entry', async () => {
    const before = await prisma.securityEvent.count();

    await prisma.$transaction(async (tx) => {
      await audit(tx, 'integration: with a security event', {
        securityEvent: {
          type: 'BRUTE_FORCE_ATTEMPT',
          severity: 'MEDIUM',
          description: 'Integration test event',
          subjectType: 'USER',
          subjectId: 'someone',
        },
      });
    });

    expect(await prisma.securityEvent.count()).toBe(before + 1);
  });

  /**
   * PDF 65: a flagged record is not an accusation. The model has no accused-user
   * column at all, and nothing about writing an event changes any other record's
   * state.
   */
  it('does not attach the event to a person as an accusation', async () => {
    const event = await prisma.securityEvent.findFirst({
      where: { description: 'Integration test event' },
      select: { subjectType: true, subjectId: true, acknowledgedAt: true, resolvedAt: true },
    });

    expect(event).not.toBeNull();
    expect(event!.acknowledgedAt).toBeNull();
    expect(event!.resolvedAt).toBeNull();
  });

  it('writes SYSTEM_ACTOR entries without an actor id', async () => {
    await prisma.$transaction(async (tx) => {
      await writeAuditEntry(
        tx,
        SYSTEM_ACTOR,
        { action: 'SYSTEM', entityType: 'SYSTEM', description: 'integration: system actor' },
        {},
      );
    });

    const entry = await prisma.auditLog.findFirst({
      where: { description: 'integration: system actor' },
      select: { actorId: true, actorName: true },
    });

    expect(entry?.actorId).toBeNull();
    expect(entry?.actorName).toBe('system');
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
