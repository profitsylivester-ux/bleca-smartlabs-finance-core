import { describe, expect, it } from 'vitest';
import {
  GENESIS_HASH,
  computeEntryHash,
  computeSignature,
  isGenesis,
  serializeForHash,
} from '@/lib/audit/chain';

const base = {
  sequence: 5n,
  previousHash: 'a'.repeat(64),
  actorId: 'user-1',
  action: 'LOGIN',
  entityType: 'SESSION',
  entityId: 'session-1',
  description: 'Signed in from Chrome on Windows',
  changes: null,
  occurredAt: new Date('2026-01-15T10:30:00.000Z'),
};

describe('audit hash chain', () => {
  it('produces a 64-character lowercase hex hash', () => {
    expect(computeEntryHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for identical input', () => {
    expect(computeEntryHash(base)).toBe(computeEntryHash({ ...base }));
  });

  it('recognises the genesis entry', () => {
    expect(isGenesis(GENESIS_HASH)).toBe(true);
    expect(isGenesis('a'.repeat(64))).toBe(false);
  });

  it('serialises fields in a stable order regardless of key order', () => {
    const a = serializeForHash({ ...base });
    const reordered = serializeForHash({
      occurredAt: base.occurredAt,
      changes: base.changes,
      description: base.description,
      entityId: base.entityId,
      entityType: base.entityType,
      action: base.action,
      actorId: base.actorId,
      previousHash: base.previousHash,
      sequence: base.sequence,
    });

    expect(a).toBe(reordered);
  });

  /**
   * Each of these fields is covered by the hash. If any one of them were not, an
   * attacker could alter that aspect of an entry and the chain would still verify.
   */
  it.each([
    ['sequence', { sequence: 6n }],
    ['previousHash', { previousHash: 'b'.repeat(64) }],
    ['actorId', { actorId: 'user-2' }],
    ['action', { action: 'LOGOUT' }],
    ['entityType', { entityType: 'USER' }],
    ['entityId', { entityId: 'session-2' }],
    ['description', { description: 'Approved invoice INV-001' }],
    ['changes', { changes: { field: { from: 'a', to: 'b' } } }],
    ['occurredAt', { occurredAt: new Date('2026-01-15T10:30:01.000Z') }],
  ])('changes the hash when %s changes', (_field, patch) => {
    expect(computeEntryHash({ ...base, ...patch })).not.toBe(computeEntryHash(base));
  });

  /**
   * Null and empty string must hash differently. If they collapsed, an attacker
   * could swap a null actorId for an empty one - or a null entityId for a
   * plausible-looking value - without breaking the chain.
   */
  it('distinguishes null from empty string in nullable fields', () => {
    expect(computeEntryHash({ ...base, actorId: null })).not.toBe(
      computeEntryHash({ ...base, actorId: '' }),
    );
  });

  it('includes the changes payload in the hash', () => {
    const withChanges = computeEntryHash({
      ...base,
      changes: { email: { from: 'a@x.co', to: 'b@x.co' } },
    });
    const withOtherChanges = computeEntryHash({
      ...base,
      changes: { email: { from: 'a@x.co', to: 'c@x.co' } },
    });

    expect(withChanges).not.toBe(withOtherChanges);
  });

  /**
   * The field separator is a control character, which cannot appear in any of the
   * hashed parts. Without it, moving a character across a boundary could produce
   * an identical serialisation and therefore an identical hash for a different
   * logical entry.
   */
  it('cannot be confused by shifting content across field boundaries', () => {
    const left = computeEntryHash({ ...base, action: 'LOGIN', entityId: 'XX' });
    const right = computeEntryHash({ ...base, action: 'LOGINX', entityId: '' });

    expect(left).not.toBe(right);
  });
});

describe('audit signatures', () => {
  it('produces a hex signature over the entry hash', () => {
    const hash = computeEntryHash(base);
    const signature = computeSignature(hash);

    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same hash', () => {
    const hash = computeEntryHash(base);
    expect(computeSignature(hash)).toBe(computeSignature(hash));
  });

  it('changes when the entry hash changes', () => {
    const a = computeSignature(computeEntryHash(base));
    const b = computeSignature(computeEntryHash({ ...base, action: 'LOGOUT' }));

    expect(a).not.toBe(b);
  });
});
