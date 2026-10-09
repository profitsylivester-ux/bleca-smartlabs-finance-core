import { hash, verify } from '@node-rs/argon2';
import { env } from '@/lib/env';
import { ValidationError } from '@/lib/kernel/errors';

/**
 * Password hashing (PDF 4, BUILD_PROMPT 7: argon2 preferred, bcrypt acceptable).
 *
 * Argon2id parameters are explicit rather than library defaults so that a change
 * is visible in a diff and reviewable. The algorithm itself is left at the
 * library default (argon2id) because @node-rs/argon2 exports it as an ambient
 * const enum, which cannot be referenced under isolatedModules.
 *
 * If you tune these parameters, re-hash on next sign-in: old hashes keep working
 * because argon2 records its own parameters in the hash string.
 */
function options() {
  return {
    memoryCost: env().ARGON2_MEMORY_COST,
    timeCost: env().ARGON2_TIME_COST,
    parallelism: env().ARGON2_PARALLELISM,
  };
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password, options());
}

/**
 * Verifies a password against a stored argon2id hash.
 *
 * Returns false rather than throwing on a malformed hash: a corrupted row must
 * read as "wrong password", not as a server error that tells an attacker the
 * account exists in a different shape.
 */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password, options());
  } catch {
    return false;
  }
}

export interface PasswordPolicy {
  minLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumber: boolean;
  requireSymbol: boolean;
}

export interface PasswordCheck {
  ok: boolean;
  problems: string[];
}

export function checkPasswordStrength(password: string, policy: PasswordPolicy): PasswordCheck {
  const problems: string[] = [];

  if (password.length < policy.minLength) {
    problems.push(`Must be at least ${policy.minLength} characters long.`);
  }
  if (policy.requireUppercase && !/[A-Z]/.test(password))
    problems.push('Must contain an uppercase letter.');
  if (policy.requireLowercase && !/[a-z]/.test(password))
    problems.push('Must contain a lowercase letter.');
  if (policy.requireNumber && !/[0-9]/.test(password)) problems.push('Must contain a number.');
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(password)) {
    problems.push('Must contain a symbol.');
  }

  return { ok: problems.length === 0, problems };
}

export function assertPasswordStrength(password: string, policy: PasswordPolicy): void {
  const result = checkPasswordStrength(password, policy);
  if (!result.ok) {
    throw new ValidationError('Password does not meet the policy.', { problems: result.problems });
  }
}

/**
 * A password identical to the email local-part is a common first guess and is
 * rejected outright rather than merely failing a regex.
 */
export function looksLikeEmail(password: string, email: string): boolean {
  const local = email.split('@')[0]?.toLowerCase() ?? '';
  if (!local) return false;
  return password.toLowerCase().includes(local);
}
