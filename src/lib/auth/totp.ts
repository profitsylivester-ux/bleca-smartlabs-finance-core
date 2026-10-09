import { authenticator, totp } from 'otplib';
import { encryptSecret, decryptSecret, randomToken } from '@/lib/crypto';
import { env } from '@/lib/env';

/**
 * TOTP MFA (PDF 4).
 *
 * Enforced for CEO and Finance Officer by default (BUILD_PROMPT 7). The secret is
 * stored encrypted and is never returned, never logged and never included in an
 * audit `changes` payload.
 *
 * Replay protection: `checkDelta` reports which 30-second window matched, and
 * `lastUsedCounter` records the highest accepted window. A code is accepted
 * once. An attacker who captures a code has a 30-second window, not a lifetime.
 */

const STEP = 30;
const DIGITS = 6;
/** Accept one window either side to tolerate clock drift on a phone. */
const WINDOW = 1;

// otplib v12 reads the acceptance window from module options rather than from
// checkDelta's signature.
totp.options = { step: STEP, window: WINDOW };

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

export function encryptTotpSecret(secret: string): string {
  return encryptSecret(secret);
}

export function decryptTotpSecret(encrypted: string): string {
  return decryptSecret(encrypted);
}

export function generateRecoveryCodes(count = 8): { plain: string[]; encrypted: string } {
  const plain = Array.from({ length: count }, () => {
    // 10 chars, no ambiguous symbols, easy to read aloud or transcribe.
    const raw = randomToken(8).replace(/[^A-Za-z0-9]/g, '');
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`.toUpperCase();
  });
  return { plain, encrypted: encryptSecret(plain.join('\n')) };
}

export function verifyRecoveryCode(encrypted: string, candidate: string): boolean {
  const codes = decryptSecret(encrypted)
    .split('\n')
    .map((c) => c.trim().toUpperCase());
  return codes.includes(candidate.trim().toUpperCase());
}

export interface OtpUriOptions {
  accountName: string;
  issuer?: string;
  secret: string;
}

/**
 * otpauth:// URI for the QR code.
 *
 * Built explicitly rather than via authenticator.keyuri, which emits
 * `secret=undefined` on otplib v12. A QR code that scans to an unusable entry is
 * worse than no QR code, so the format is written out where it can be read and
 * reviewed.
 */
export function buildOtpAuthUri(options: OtpUriOptions): string {
  const issuer = options.issuer ?? env().MFA_ISSUER;
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(options.accountName)}`;
  const params = new URLSearchParams({
    secret: options.secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export interface VerifyTotpResult {
  valid: boolean;
  /** Window counter that matched, used for replay rejection. */
  counter: number | null;
  reason?: 'NO_MATCH' | 'REPLAYED' | 'EMPTY';
}

export function verifyTotpCode(
  encryptedSecret: string,
  code: string,
  lastUsedCounter: number,
): VerifyTotpResult {
  const normalized = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) {
    return { valid: false, counter: null, reason: 'EMPTY' };
  }

  const secret = decryptTotpSecret(encryptedSecret);
  const delta = totp.checkDelta(normalized, secret);

  if (delta === null || delta === undefined) {
    return { valid: false, counter: null, reason: 'NO_MATCH' };
  }

  // totp.checkDelta returns steps relative to "now"; convert to an absolute
  // counter so the stored value stays meaningful across time.
  const counter = totpCounterNow() + delta;

  if (counter <= lastUsedCounter) {
    return { valid: false, counter: null, reason: 'REPLAYED' };
  }

  return { valid: true, counter };
}

export function totpCounterNow(): number {
  return Math.floor(Date.now() / 1000 / STEP);
}

export function currentTotpCode(secret: string): string {
  return totp.generate(secret);
}

export const TOTP_CONFIG = { step: STEP, digits: DIGITS, window: WINDOW } as const;
