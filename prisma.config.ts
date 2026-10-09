import 'dotenv/config';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
    // Hand-written guards (append-only audit trigger, hash-chain head, least
    // privilege runtime role) live in prisma/raw and are applied inside
    // migrations via $executeRawUnsafe in the migration SQL itself. See
    // prisma/migrations/*_audit_guards/migration.sql.
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // Prisma 7 moves the URL out of schema.prisma. Declaring it here now keeps
    // the Q12 decision (Supabase Postgres, Neon a config change) genuinely cheap.
    url: process.env.DATABASE_URL ?? '',
  },
});
