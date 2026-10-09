import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PrismaClient } from '@/generated/prisma/client';

const require = createRequire(import.meta.url);

/**
 * Prepares the integration test database.
 *
 * 1. RESETS the database, then 2. re-applies migrations, then 3. seeds fixtures.
 *
 * The reset is not laziness, it is correctness. The audit chain is a single
 * global sequence that is deliberately never rewound: audit_logs has triggers
 * that forbid DELETE and TRUNCATE, so a database left over from a previous run
 * carries entries hashed under whatever the algorithm was then. Re-running the
 * suite against it would report the code's own earlier version as tampering.
 *
 * That is safe precisely because this is a throwaway database. It is created by
 * TEST_DATABASE_URL (docker-compose service `postgres-test`) and is never the
 * development or production one - see the guard below.
 *
 * Uses `migrate deploy`, not `migrate dev`: deploy never generates a migration
 * or alters the schema beyond applying what is already committed. A test suite
 * that could invent a schema change would be testing something other than what
 * ships.
 *
 * Invokes the Prisma CLI through node directly rather than through `npx`,
 * because npx is a shell shim that is not on PATH for a spawned process on
 * Windows and would make the suite unrunnable there.
 */
export default async function globalSetup(): Promise<void> {
  const testUrl = process.env.TEST_DATABASE_URL;

  if (!testUrl) {
    throw new Error('TEST_DATABASE_URL is required. Refusing to run against an unknown database.');
  }

  // Refuse to run if the test URL and the dev URL are the same database. The
  // reset below drops the schema, and it must never be pointed at real data.
  const devUrl = process.env.DATABASE_URL;
  if (devUrl && devUrl.replace(/\?.*$/, '') === testUrl.replace(/\?.*$/, '')) {
    throw new Error(
      'TEST_DATABASE_URL and DATABASE_URL point at the same database. Integration tests drop and ' +
        'recreate the schema, so this must be a dedicated throwaway database.',
    );
  }

  const prismaCli = path.join(
    path.dirname(require.resolve('prisma/package.json')),
    'build',
    'index.js',
  );
  const cliEnv = { ...process.env, DATABASE_URL: testUrl };

  execFileSync(
    process.execPath,
    [prismaCli, 'migrate', 'reset', '--force', '--skip-seed', '--skip-generate'],
    { cwd: process.cwd(), env: cliEnv, stdio: 'inherit' },
  );

  const prisma = new PrismaClient({
    datasources: { db: { url: testUrl } },
  });

  try {
    const { seedTestFixtures } = await import('./fixtures');
    await seedTestFixtures(prisma);
  } finally {
    await prisma.$disconnect();
  }
}
