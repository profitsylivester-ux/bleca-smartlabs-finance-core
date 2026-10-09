import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Three suites with genuinely different needs, kept separate so that the fast
 * one stays fast and the slow one stays honest.
 *
 *   unit        pure domain logic, no database
 *   integration real Postgres - exists to prove the guarantees Prisma cannot
 *               express (append-only trigger, hash chain, tenant isolation)
 *   ui          React components in jsdom
 *
 * `extends: true` inherits the root config, so a shared option added later does
 * not silently apply to two suites out of three.
 */
export default defineConfig({
  test: {
    /**
     * Integration tests share one Postgres database and the audit hash chain is a
     * single global sequence. Running them in parallel would make chain
     * assertions non-deterministic, and determinism is the entire point of those
     * tests. The unit and ui projects are fast enough to stay useful under this.
     */
    fileParallelism: false,
    projects: [
      {
        extends: true,
        plugins: [tsconfigPaths()],
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/tests/integration/**', 'src/**/*.integration.test.ts', 'e2e/**'],
          setupFiles: [r('./src/tests/setup/unit.ts')],
        },
      },
      {
        extends: true,
        plugins: [tsconfigPaths()],
        test: {
          name: 'integration',
          environment: 'node',
          include: ['src/tests/integration/**/*.test.ts'],
          setupFiles: [r('./src/tests/setup/integration.ts')],
          globalSetup: [r('./src/tests/setup/integration-setup.ts')],
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
      {
        extends: true,
        plugins: [react(), tsconfigPaths()],
        test: {
          name: 'ui',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx'],
          setupFiles: [r('./src/tests/setup/ui.ts')],
        },
      },
    ],
  },
});
