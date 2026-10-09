import { canonicalJson, hmacSha256Hex, sha256Hex } from '@/lib/crypto';
import { auditHmacKey } from '@/lib/env';
import type { AuditActor } from '@/lib/audit/types';

/**
 * The hash chain (PHASE_1_PLAN.md 3.8.5).
 *
 *   entry_hash = sha256(previous_hash, sequence, actor_id, action,
 *                       entity_type, entity_id, changes, occurred_at)
 *   signature  = HMAC-SHA256(entry_hash, period_key)
 *
 * Properties this buys:
 *   * Order is provable. Reordering two entries breaks both links.
 *   * Content is provable. Editing any hashed field breaks every later link.
 *   * Insertion is provable. A forged entry needs the HMAC key, which never
 *     leaves the environment.
 *   * Deletion is provable. A missing entry leaves a sequence gap, and the
 *     database trigger in the audit_guards migration refuses to write the entry
 *     that would close such a gap.
 *
 * Every hashed field is serialised canonically. Two runs that produce the same
 * logical entry must produce the same bytes, or the chain would report its own
 * bug as tampering.
 */

export const GENESIS_HASH = '';

export interface ChainPayload {
  sequence: bigint;
  previousHash: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  description: string;
  changes: unknown;
  occurredAt: Date;
}

/**
 * Serialises the hashed fields as a JSON array.
 *
 * An array, and that is the whole point. In a joined string, `null` and `''`
 * collapse to the same empty field, so swapping a null actorId for an empty one -
 * or a null entityId for a plausible-looking value - would leave the hash
 * unchanged and the chain would still verify. JSON encodes them differently, so
 * the substitution breaks the chain.
 *
 * Array position carries the meaning, which also removes the need for a separate
 * separator character: "LOGIN" + "XX" and "LOGINX" + "" cannot serialise to the
 * same bytes, so content cannot be shifted across a boundary to forge a match.
 *
 * `description` is hashed in addition to the eight fields listed in
 * PHASE_1_PLAN.md 3.8.5. Those eight describe WHO did WHAT to WHICH record; the
 * description is the human-readable statement of the same event, and leaving it
 * mutable would let someone rewrite the narrative of an entry - "approved
 * invoice" into "denied invoice" - without breaking anything. The deviation is
 * deliberate and it is a strengthening, not a relaxation.
 */
export function serializeForHash(payload: ChainPayload): string {
  return JSON.stringify([
    payload.previousHash,
    payload.sequence.toString(),
    payload.actorId,
    payload.action,
    payload.entityType,
    payload.entityId,
    payload.description,
    canonicalJson(payload.changes ?? null),
    payload.occurredAt.toISOString(),
  ]);
}

export function computeEntryHash(payload: ChainPayload): string {
  return sha256Hex(serializeForHash(payload));
}

export function computeSignature(entryHash: string): string {
  return hmacSha256Hex(auditHmacKey(), entryHash);
}

export function actorIdOf(actor: AuditActor): string | null {
  return actor.id;
}

/** Genesis entry: sequence 1, previous hash "". */
export function isGenesis(previousHash: string): boolean {
  return previousHash === GENESIS_HASH;
}
