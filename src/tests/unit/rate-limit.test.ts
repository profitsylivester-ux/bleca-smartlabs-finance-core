import { describe, expect, it } from 'vitest';
import { checkRateLimit, clearRateLimits } from '@/lib/auth/rate-limit';

describe('rate limiting', () => {
  it('allows attempts up to the limit, then blocks', () => {
    clearRateLimits();
    const now = 1_700_000_000_000;

    for (let i = 0; i < 3; i += 1) {
      expect(checkRateLimit('acct:a', 3, 60, now).allowed).toBe(true);
    }

    const blocked = checkRateLimit('acct:a', 3, 60, now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('reports the remaining allowance', () => {
    clearRateLimits();
    const now = 1_700_000_000_000;

    expect(checkRateLimit('acct:b', 3, 60, now).remaining).toBe(2);
    expect(checkRateLimit('acct:b', 3, 60, now).remaining).toBe(1);
    expect(checkRateLimit('acct:b', 3, 60, now).remaining).toBe(0);
  });

  it('frees up as the window slides', () => {
    clearRateLimits();
    const start = 1_700_000_000_000;

    checkRateLimit('acct:c', 1, 60, start);
    expect(checkRateLimit('acct:c', 1, 60, start + 1_000).allowed).toBe(false);

    // 61 seconds later the original attempt has aged out of the window.
    expect(checkRateLimit('acct:c', 1, 60, start + 61_000).allowed).toBe(true);
  });

  /**
   * Per-account and per-IP are separate buckets. Collapsing them would let a
   * distributed credential-stuffing run against one account be hidden behind a
   * shared per-IP counter, or let one locked account exhaust a whole network's
   * allowance.
   */
  it('keeps separate buckets independent', () => {
    clearRateLimits();
    const now = 1_700_000_000_000;

    checkRateLimit('account:x', 1, 60, now);
    checkRateLimit('ip:1.2.3.4', 1, 60, now);

    expect(checkRateLimit('account:y', 1, 60, now).allowed).toBe(true);
    expect(checkRateLimit('ip:5.6.7.8', 1, 60, now).allowed).toBe(true);
    expect(checkRateLimit('account:x', 1, 60, now).allowed).toBe(false);
    expect(checkRateLimit('ip:1.2.3.4', 1, 60, now).allowed).toBe(false);
  });

  it('gives an accurate retry-after that counts down', () => {
    clearRateLimits();
    const start = 1_700_000_000_000;

    checkRateLimit('acct:d', 1, 60, start);
    const first = checkRateLimit('acct:d', 1, 60, start + 20_000);

    expect(first.retryAfterSeconds).toBeLessThanOrEqual(40);
    expect(first.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('clearRateLimits resets everything, for test isolation', () => {
    clearRateLimits();
    const now = 1_700_000_000_000;

    checkRateLimit('acct:e', 1, 60, now);
    expect(checkRateLimit('acct:e', 1, 60, now).allowed).toBe(false);

    clearRateLimits();
    expect(checkRateLimit('acct:e', 1, 60, now).allowed).toBe(true);
  });
});
