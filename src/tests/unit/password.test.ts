import { describe, expect, it } from 'vitest';
import {
  assertPasswordStrength,
  checkPasswordStrength,
  hashPassword,
  looksLikeEmail,
  verifyPassword,
  type PasswordPolicy,
} from '@/lib/auth/password';

const POLICY: PasswordPolicy = {
  minLength: 12,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSymbol: true,
};

describe('argon2id password hashing', () => {
  it('round-trips a correct password', async () => {
    const hash = await hashPassword('CorrectHorse#Battery9');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    await expect(verifyPassword(hash, 'CorrectHorse#Battery9')).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('CorrectHorse#Battery9');
    await expect(verifyPassword(hash, 'CorrectHorse#Battery8')).resolves.toBe(false);
  });

  it('produces a different hash for the same password each time (unique salt)', async () => {
    const a = await hashPassword('CorrectHorse#Battery9');
    const b = await hashPassword('CorrectHorse#Battery9');
    expect(a).not.toBe(b);
  });

  /**
   * A corrupt hash must read as "wrong password", not as a server error. The
   * difference matters: an error path that differs by failure mode tells an
   * attacker the account exists in a different shape than expected.
   */
  it('treats a malformed stored hash as a failed verification, not a throw', async () => {
    await expect(verifyPassword('not-a-hash', 'anything')).resolves.toBe(false);
  });

  it('resists an empty password', async () => {
    const hash = await hashPassword('CorrectHorse#Battery9');
    await expect(verifyPassword(hash, '')).resolves.toBe(false);
  });
});

describe('checkPasswordStrength', () => {
  it('accepts a password meeting the policy', () => {
    expect(checkPasswordStrength('CorrectHorse#9', POLICY).ok).toBe(true);
  });

  it('reports every problem rather than stopping at the first', () => {
    const result = checkPasswordStrength('short', POLICY);
    expect(result.ok).toBe(false);
    expect(result.problems.length).toBeGreaterThanOrEqual(4);
  });

  it('enforces length', () => {
    const result = checkPasswordStrength('Ab#1234567', POLICY);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain('at least 12');
  });

  it.each([
    ['all lower', 'correcthorse#9', /uppercase/],
    ['no digit', 'CorrectHorseBattery#', /number/],
    ['no symbol', 'CorrectHorse99', /symbol/],
  ])('rejects %s', (_label, password, pattern) => {
    const result = checkPasswordStrength(password, POLICY);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(pattern);
  });
});

describe('assertPasswordStrength', () => {
  it('throws with the problems attached', () => {
    expect(() => assertPasswordStrength('weak', POLICY)).toThrow(/does not meet the policy/);
  });

  it('does not throw for a compliant password', () => {
    expect(() => assertPasswordStrength('CorrectHorse#9', POLICY)).not.toThrow();
  });
});

describe('looksLikeEmail', () => {
  /**
   * A password built from the address is one of the first things anyone tries.
   * Rejecting it outright is cheaper and clearer than relying on the strength
   * rules to catch it, which they do not.
   *
   * Signature is (password, email).
   */
  it('rejects a password containing the email local part', () => {
    expect(looksLikeEmail('chrisbwesa2026#', 'chrisbwesa@bleca.co.tz')).toBe(true);
  });

  it('allows an unrelated password', () => {
    expect(looksLikeEmail('CorrectHorse#9', 'ceo@bleca.co.tz')).toBe(false);
  });

  it('handles a malformed address without throwing', () => {
    expect(looksLikeEmail('anything', 'not-an-email')).toBe(false);
  });
});
