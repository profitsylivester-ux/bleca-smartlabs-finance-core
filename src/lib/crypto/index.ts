import crypto from 'node:crypto';
import { env } from '@/lib/env';

/**
 * Symmetric encryption for secrets at rest (TOTP seeds, recovery codes, reset
 * tokens, treasury account numbers in later milestones).
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather
 * than yielding garbage. The auth tag is what makes that guarantee; ECB or
 * unauthenticated CBC would not be acceptable for this data.
 *
 * Format: v1.<iv-b64url>.<tag-b64url>.<ciphertext-b64url>
 * The version prefix exists so key rotation and algorithm changes are additive.
 */

const VERSION = 'v1';

function key(): Buffer {
  const k = Buffer.from(env().ENCRYPTION_KEY, 'base64');
  if (k.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must be exactly 32 bytes, got ${k.length}`);
  }
  return k;
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptSecret(payload: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Unrecognised ciphertext format');
  }
  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function hashToken(token: string): string {
  /**
   * Purpose-built for high-entropy random tokens (password reset, session
   * tokens). Argon2 is deliberately NOT used here: these values are already
   * 256 bits of CSPRNG output, so there is no dictionary to slow down, and the
   * slow hash would only add latency to every reset link.
   */
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Deterministic JSON with sorted keys.
 *
 * The audit hash chain depends on the same logical payload always producing the
 * same bytes. Plain JSON.stringify does not guarantee that: key order follows
 * insertion order, so two identical entries hashed on different runs could
 * produce different entry hashes and look like tampering.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

export function hmacSha256Hex(keyMaterial: Buffer, input: string): string {
  return crypto.createHmac('sha256', keyMaterial).update(input, 'utf8').digest('hex');
}
