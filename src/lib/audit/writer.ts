import { Prisma } from '@/generated/prisma/client';
import type { Tx } from '@/lib/db/prisma';
import { computeEntryHash, computeSignature } from '@/lib/audit/chain';
import type { AuditActor, AuditEntryInput, SecurityEventInput } from '@/lib/audit/types';

/**
 * The only function permitted to insert into audit_logs.
 *
 * There is no update function and no delete function in this codebase. If you
 * are reading this looking for one, it does not exist on purpose, and the
 * database would reject it anyway.
 */
export async function writeAuditEntry(
  tx: Tx,
  actor: AuditActor,
  input: AuditEntryInput,
  options: {
    organizationId?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
    requestId?: string | null;
    sessionId?: string | null;
  } = {},
): Promise<{ id: string; sequence: bigint; entryHash: string }> {
  const occurredAt = input.occurredAt ?? new Date();

  /**
   * Lock the chain head for the remainder of this transaction.
   *
   * This is what serialises concurrent appends. Two requests cannot both read the
   * same head and both write sequence N+1: the second blocks here until the first
   * commits or rolls back. Without it, "last write wins" would silently drop an
   * audit entry.
   */
  const heads = await tx.$queryRaw<Array<{ sequence: bigint; entry_hash: string }>>`
    SELECT sequence, entry_hash FROM audit_chain_head WHERE id = 1 FOR UPDATE
  `;

  const head = heads[0];
  if (!head) {
    throw new Error(
      'audit_chain_head is missing. The audit chain cannot be extended. Run prisma migrate deploy.',
    );
  }

  const sequence = head.sequence + 1n;
  const previousHash = head.entry_hash;

  const entryHash = computeEntryHash({
    sequence,
    previousHash,
    actorId: actor.id,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    description: input.description,
    changes: input.changes ?? null,
    occurredAt,
  });

  const signature = computeSignature(entryHash);

  const row = await tx.auditLog.create({
    data: {
      organizationId: options.organizationId ?? null,
      sequence,
      previousHash,
      entryHash,
      signature,
      actorId: actor.id,
      actorName: actor.name,
      actorRoleCodes: actor.roleCodes,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      entityLabel: input.entityLabel ?? null,
      description: input.description,
      changes: (input.changes ?? undefined) as Prisma.InputJsonValue | undefined,
      metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      ipAddress: options.ipAddress ?? null,
      userAgent: options.userAgent ?? null,
      requestId: options.requestId ?? null,
      sessionId: options.sessionId ?? null,
      channel: input.channel ?? 'WEB',
      result: input.result ?? 'SUCCESS',
      errorMessage: input.errorMessage ?? null,
      occurredAt,
    },
    select: { id: true },
  });

  if (input.securityEvent) {
    await writeSecurityEvent(tx, row.id, input.securityEvent, options);
  }

  // Advance the head in the SAME transaction. If anything above throws, both the
  // audit row and this update roll back together and the sequence number is
  // returned to the pool.
  await tx.$executeRaw`
    UPDATE audit_chain_head
       SET sequence = ${sequence}, entry_hash = ${entryHash}, updated_at = now()
     WHERE id = 1
  `;

  return { id: row.id, sequence, entryHash };
}

/**
 * Security events are records, not verdicts.
 *
 * The subject is the thing that happened, not the person. Nothing here blocks,
 * rejects or escalates anything: a named human must acknowledge the event before
 * it has any effect. That follows PDF 65 ("AI may flag anomalies but shall not
 * independently accuse a person or make a consequential decision").
 */
export async function writeSecurityEvent(
  tx: Tx,
  auditLogId: string,
  event: SecurityEventInput,
  options: {
    organizationId?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
    requestId?: string | null;
  } = {},
): Promise<void> {
  await tx.securityEvent.create({
    data: {
      organizationId: options.organizationId ?? null,
      auditLogId,
      type: event.type,
      severity: event.severity,
      subjectType: event.subjectType ?? null,
      subjectId: event.subjectId ?? null,
      subjectLabel: event.subjectLabel ?? null,
      description: event.description,
      detail: (event.detail ?? undefined) as Prisma.InputJsonValue | undefined,
      ipAddress: options.ipAddress ?? null,
      userAgent: options.userAgent ?? null,
      requestId: options.requestId ?? null,
    },
  });
}

export const SYSTEM_ACTOR: AuditActor = {
  id: null,
  name: 'system',
  roleCodes: ['SYSTEM'],
};
