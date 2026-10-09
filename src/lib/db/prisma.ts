import { PrismaClient } from '@/generated/prisma/client';
import { env } from '@/lib/env';

/**
 * Single Prisma instance.
 *
 * In development Next.js re-evaluates modules on every hot reload; without the
 * global cache each reload would open a new connection pool and Postgres would
 * eventually refuse connections.
 */
const globalForPrisma = globalThis as unknown as { __blecaPrisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.__blecaPrisma ??
  new PrismaClient({
    log: env().NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (env().NODE_ENV !== 'production') {
  globalForPrisma.__blecaPrisma = prisma;
}

export type { PrismaClient };
export type Tx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;
