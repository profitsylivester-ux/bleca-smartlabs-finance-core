import { describe, expect, it } from 'vitest';
import {
  buildOtpAuthUri,
  currentTotpCode,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  verifyRecoveryCode,
  verifyTotpCode,
} from '@/lib/auth/totp';

describe('TOTP enrolment', () => {
  it('generates a secret of the expected shape', () => {
    const secret = generateTotpSecret();
    expect(secret.length).toBeGreaterThanOrEqual(16);
    expect(secret).toMatch(/^[A-Z2-7]+=*$/i);
  });

  /**
   * otplib v12's authenticator.keyuri() emits `secret=undefined`, which produces
   * a QR code that scans to an unusable entry. The URI is therefore built by
   * hand, and this test is the thing that would catch a regression to keyuri.
   */
  it('builds a scannable otpauth URI with the secret actually present', () => {
    const uri = buildOtpAuthUri({
      accountName: 'ceo@blecasmartlabs.co.tz',
      secret: 'JBSWY3DPEHPK3PXP',
    });

    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).not.toContain('undefined');
    expect(uri).toContain('issuer=BLECA');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});

describe('verifyTotpCode', () => {
  it('accepts the current code', () => {
    const secret = generateTotpSecret();
    const encrypted = encryptTotpSecret(secret);
    const code = currentTotpCode(secret);

    const result = verifyTotpCode(encrypted, code, -1);
    expect(result.valid).toBe(true);
    expect(result.counter).toBeGreaterThan(0);
  });

  /**
   * Replay protection. Without this, a code observed in transit is good for the
   * remainder of its 30-second window every single time it is presented.
   */
  it('rejects the same code a second time', () => {
    const secret = generateTotpSecret();
    const encrypted = encryptTotpSecret(secret);
    const code = currentTotpCode(secret);

    const first = verifyTotpCode(encrypted, code, -1);
    expect(first.valid).toBe(true);

    const second = verifyTotpCode(encrypted, code, first.counter!);
    expect(second.valid).toBe(false);
    expect(second.reason).toBe('REPLAYED');
  });

  it('rejects a code from a different secret', () => {
    const secret = generateTotpSecret();
    const other = generateTotpSecret();
    const code = currentTotpCode(other);

    const result = verifyTotpCode(encryptTotpSecret(secret), code, -1);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('NO_MATCH');
  });

  it('rejects malformed input without attempting verification', () => {
    const encrypted = encryptTotpSecret(generateTotpSecret());

    expect(verifyTotpCode(encrypted, '', -1).reason).toBe('EMPTY');
    expect(verifyTotpCode(encrypted, 'abcdef', -1).reason).toBe('EMPTY');
    expect(verifyTotpCode(encrypted, '12345', -1).reason).toBe('EMPTY');
    expect(verifyTotpCode(encrypted, '1234567', -1).reason).toBe('EMPTY');
  });

  it('tolerates whitespace a user pasted in', () => {
    const secret = generateTotpSecret();
    const code = currentTotpCode(secret);

    const result = verifyTotpCode(encryptTotpSecret(secret), ` ${code} `, -1);
    expect(result.valid).toBe(true);
  });
});

describe('recovery codes', () => {
  it('generates the requested number of distinct codes', () => {
    const { plain } = generateRecoveryCodes(8);
    expect(plain).toHaveLength(8);
    expect(new Set(plain).size).toBe(8);
  });

  it('stores them encrypted and verifies one', () => {
    const { plain, encrypted } = generateRecoveryCodes(4);
    expect(encrypted).not.toContain(plain[0]!);
    expect(verifyRecoveryCode(encrypted, plain[0]!)).toBe(true);
  });

  it('is case and whitespace insensitive, because they are transcribed by hand', () => {
    const { plain, encrypted } = generateRecoveryCodes(2);
    expect(verifyRecoveryCode(encrypted, `  ${plain[1]!.toLowerCase()} `)).toBe(true);
  });

  it('rejects a code that was not issued', () => {
    const { encrypted } = generateRecoveryCodes(2);
    expect(verifyRecoveryCode(encrypted, 'AAAAA-BBBBB')).toBe(false);
  });
});
