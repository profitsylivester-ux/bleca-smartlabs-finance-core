import { PrismaClient, AccountSubCategory } from '@/generated/prisma/client';
import { env } from '@/lib/env';

const globalForPrisma = globalThis as unknown as { __blecaPrisma?: PrismaClient };

const prismaInstance: PrismaClient =
  globalForPrisma.__blecaPrisma ??
  new PrismaClient({
    log: env().NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (env().NODE_ENV !== 'production') {
  globalForPrisma.__blecaPrisma = prismaInstance;
}

export { prismaInstance as prisma, AccountSubCategory };
export type { PrismaClient };
export type Tx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;