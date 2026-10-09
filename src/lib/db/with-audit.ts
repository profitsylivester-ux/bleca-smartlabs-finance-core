import { prisma, type Tx } from '@/lib/db/prisma';
import { writeAuditEntry } from '@/lib/audit/writer';
import type { AuditActor, AuditEntryInput } from '@/lib/audit/types';

/**
 * Audit actor comes from the authenticated request, never from the payload.
 * A client cannot claim to be someone else by putting their id in a body field.
 */
export interface AuditContext {
  organizationId?: string | null;
  actor: AuditActor;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  sessionId?: string | null;
}

/**
 * withAudit - the transaction wrapper every mutating service function uses.
 *
 * The contract (PHASE_1_PLAN.md 7.4):
 *
 *   The audit write happens in the SAME database transaction as the business
 *   mutation. If the audit insert fails, the mutation rolls back with it. An
 *   unaudited mutation is therefore not merely discouraged, it is unreachable.
 *
 * Note what this does NOT do: it does not write a compensating entry on failure.
 * A rollback leaves no trace of the attempted mutation in audit_logs, which is
 * correct - there was no state change - and is exactly why the failure paths that
 * DO matter (a denial, a failed login, a rejected attempt) are written in their
 * own committed transaction via recordAuditEvent below.
 */
export async function withAudit<T>(
  ctx: AuditContext,
  fn: (tx: Tx) => Promise<T>,
  entry?: Omit<AuditEntryInput, 'bestEffort'>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const result = await fn(tx);

    if (entry) {
      await writeAuditEntry(
        tx,
        ctx.actor,
        { ...entry, bestEffort: false },
        {
          organizationId: ctx.organizationId,
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
          requestId: ctx.requestId,
          sessionId: ctx.sessionId,
        },
      );
    }

    return result;
  });
}

/**
 * Writes an audit entry in its own committed transaction.
 *
 * Used for events that describe something which did NOT change state: a denied
 * request, a failed login, a rejected approval attempt, a detected anomaly. These
 * must survive even though the operation they describe was rolled back.
 */
export async function recordAuditEvent(ctx: AuditContext, entry: AuditEntryInput): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const written = await writeAuditEntry(
      tx,
      ctx.actor,
      { ...entry, bestEffort: false },
      {
        organizationId: ctx.organizationId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
        sessionId: ctx.sessionId,
      },
    );
    return written.id;
  });
}
