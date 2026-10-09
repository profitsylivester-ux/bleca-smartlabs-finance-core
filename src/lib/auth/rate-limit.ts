/**
 * Rate limiting (PDF 4).
 *
 * In-process sliding window. Sufficient for Phase 1 because the deployment is a
 * single Next.js instance; the interface is deliberately narrow so that a shared
 * store (Redis, or Postgres) can be substituted when horizontal scaling arrives
 * without touching any caller.
 *
 * Two limits are enforced separately, because they defend against different
 * attacks:
 *   - per-account, catches credential stuffing against one user
 *   - per-IP, catches a spray across many accounts from one host
 */

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window frees up. Zero when allowed. */
  retryAfterSeconds: number;
  limit: number;
}

interface Bucket {
  timestamps: number[];
}

const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();

/** Bounds memory if the process is hit with many distinct keys. */
const MAX_BUCKETS = 20_000;
const SWEEP_INTERVAL_MS = 60_000;

function sweep(now: number, windowMs: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS && buckets.size < MAX_BUCKETS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);
    if (bucket.timestamps.length === 0) buckets.delete(key);
  }
}

export function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
  now = Date.now(),
): RateLimitDecision {
  sweep(now, windowSeconds * 1000);

  const windowMs = windowSeconds * 1000;
  const bucket = buckets.get(key) ?? { timestamps: [] };
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);

  if (bucket.timestamps.length >= limit) {
    const oldest = bucket.timestamps[0] ?? now;
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    buckets.set(key, bucket);
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds,
      limit,
    };
  }

  bucket.timestamps.push(now);
  buckets.set(key, bucket);

  return {
    allowed: true,
    remaining: limit - bucket.timestamps.length,
    retryAfterSeconds: 0,
    limit,
  };
}

export function clearRateLimits(): void {
  buckets.clear();
}

export const rateLimitKeys = {
  account: (emailNormalized: string) => `login:account:${emailNormalized}`,
  ip: (ip: string) => `login:ip:${ip}`,
  mfa: (emailNormalized: string) => `mfa:${emailNormalized}`,
  reset: (emailNormalized: string) => `reset:${emailNormalized}`,
} as const;
