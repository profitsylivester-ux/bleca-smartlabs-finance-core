import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  decryptSecret,
  encryptSecret,
  hashToken,
  randomToken,
  sha256Hex,
  timingSafeEqual,
} from '@/lib/crypto';

describe('canonicalJson', () => {
  /**
   * The hash chain's correctness rests on this. JSON.stringify preserves
   * insertion order, so two logically identical audit payloads built in a
   * different order would produce different entry hashes - and the chain would
   * report its own bug as tampering.
   */
  it('is stable regardless of key insertion order', () => {
    const a = { action: 'LOGIN', actorId: 'u1', sequence: 3 };
    const b = { sequence: 3, actorId: 'u1', action: 'LOGIN' };

    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(sha256Hex(canonicalJson(a))).toBe(sha256Hex(canonicalJson(b)));
  });

  it('handles nested objects and arrays', () => {
    const a = { changes: { b: 2, a: 1 }, list: [3, { y: 1, x: 2 }] };
    const b = { list: [3, { x: 2, y: 1 }], changes: { a: 1, b: 2 } };

    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('preserves array order, because array order is data', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('drops undefined rather than emitting it inconsistently', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('serialises dates to ISO so a Date and its string hash the same', () => {
    const d = new Date('2026-01-15T10:30:00.000Z');
    expect(canonicalJson({ at: d })).toBe(canonicalJson({ at: d.toISOString() }));
  });

  it('distinguishes null from an absent key', () => {
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
  });
});

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a value', () => {
    const plaintext = 'otpauth-seed-ABCDEF123456';
    expect(decryptSecret(encryptSecret(plaintext))).toBe(plaintext);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const plaintext = 'same input';
    expect(encryptSecret(plaintext)).not.toBe(encryptSecret(plaintext));
  });

  it('refuses a tampered ciphertext rather than returning garbage', () => {
    const payload = encryptSecret('secret');
    const parts = payload.split('.');
    const ciphertext = Buffer.from(parts[3]!, 'base64url');
    ciphertext[0] = (ciphertext[0]! ^ 0xff) & 0xff;
    parts[3] = ciphertext.toString('base64url');

    expect(() => decryptSecret(parts.join('.'))).toThrow();
  });

  it('rejects an unrecognised format version', () => {
    expect(() => decryptSecret('v9.a.b.c')).toThrow(/Unrecognised/);
  });
});

describe('hashToken', () => {
  it('is deterministic', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
  });

  it('does not contain the token itself', () => {
    expect(hashToken('super-secret-token')).not.toContain('super-secret-token');
  });
});

describe('randomToken', () => {
  it('produces URL-safe tokens of the requested length', () => {
    const token = randomToken(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes base64url without padding is 43 characters.
    expect(token.length).toBeGreaterThanOrEqual(42);
  });

  it('does not repeat', () => {
    expect(randomToken()).not.toBe(randomToken());
  });
});

describe('timingSafeEqual', () => {
  it('compares equal strings', () => {
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true);
  });

  it('rejects different strings and different lengths', () => {
    expect(timingSafeEqual('abc123', 'abc124')).toBe(false);
    expect(timingSafeEqual('abc', 'abcdef')).toBe(false);
  });
});
