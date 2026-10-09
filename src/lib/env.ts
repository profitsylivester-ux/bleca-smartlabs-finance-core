import { z } from 'zod';

/**
 * Environment parsing.
 *
 * Two rules:
 *   1. Fail loudly at boot. A missing or malformed secret must stop the process,
 *      not surface as a runtime surprise during a financial posting.
 *   2. No default for anything secret. Placeholder text in .env.example is
 *      rejected explicitly, so a copied .env.example cannot silently become the
 *      production configuration.
 */

const PLACEHOLDER = /^replace-me/i;

const required = (name: string) =>
  z
    .string()
    .min(1, `${name} is required`)
    .refine((v) => !PLACEHOLDER.test(v), {
      message: `${name} still holds the .env.example placeholder. Generate a real value with: openssl rand -base64 32`,
    });

const boolish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : v === 'true' || v === '1'));

const intish = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number.parseInt(v, 10)))
    .pipe(z.number().int());

const serverSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: required('DATABASE_URL'),

  AUTH_SECRET: required('AUTH_SECRET'),
  AUTH_URL: z.string().url().default('http://localhost:3000'),

  ARGON2_MEMORY_COST: intish(19456),
  ARGON2_TIME_COST: intish(2),
  ARGON2_PARALLELISM: intish(1),

  MFA_ISSUER: z.string().default('BLECA SmartLabs Finance'),

  ENCRYPTION_KEY: required('ENCRYPTION_KEY').refine(
    (v) => {
      try {
        return Buffer.from(v, 'base64').length === 32;
      } catch {
        return false;
      }
    },
    { message: 'ENCRYPTION_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)' },
  ),

  AUDIT_HMAC_KEY: required('AUDIT_HMAC_KEY'),
  AUDIT_HMAC_KEY_VALID_FROM: z.string().datetime().default('2026-01-01T00:00:00.000Z'),

  MAIL_PROVIDER: z.enum(['smtp', 'console']).default('console'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: intish(1025),
  SMTP_SECURE: boolish(false),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  MAIL_FROM: z.string().default('BLECA SmartLabs Finance <no-reply@blecasmartlabs.co.tz>'),

  STORAGE_DRIVER: z.enum(['s3', 'local']).default('local'),
  S3_ENDPOINT: z.string().default('http://localhost:4566'),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('bleca-documents'),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  S3_FORCE_PATH_STYLE: boolish(true),
  STORAGE_LOCAL_ROOT: z.string().default('./.storage'),

  SEED_CEO_EMAIL: z.string().email().optional(),
  SEED_CEO_PASSWORD: z.string().optional(),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | undefined;

/**
 * Parsed server environment. Safe to call repeatedly.
 *
 * Throws on invalid configuration. That is deliberate: a process that cannot
 * validate its own secrets must not start, because this system moves money and
 * writes an audit trail that is only trustworthy if it cannot be silently
 * misconfigured.
 */
export function env(): ServerEnv {
  if (cached) return cached;

  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }

  cached = parsed.data;
  return cached;
}

/** Test seam: drop the memoised parse. */
export function resetEnvCache(): void {
  cached = undefined;
}

/**
 * Base64 key material for the audit HMAC.
 *
 * AUDIT_HMAC_KEY is intentionally a single current key today. The schema stores
 * `signature_key_version` per entry, so adding a rotated key later is additive
 * rather than a migration over historical rows.
 */
export function auditHmacKey(): Buffer {
  const key = Buffer.from(env().AUDIT_HMAC_KEY, 'base64');
  if (key.length < 32) {
    throw new Error('AUDIT_HMAC_KEY must decode to at least 32 bytes');
  }
  return key;
}
