import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

/**
 * The one-way dependency rule (PHASE_1_PLAN.md 2.2) is the architectural
 * decision that makes the accounting core reusable by every future module. This
 * test walks the real import graph and asserts it holds.
 *
 * Why a test and not only the ESLint zones in eslint.config.mjs: lint sees the
 * import as written, and can be satisfied by a path alias, a dynamic import() or
 * a re-export barrel that the rule set does not pattern-match. Reading the graph
 * cannot be fooled that way, because it follows what the module actually
 * depends on at runtime.
 */

interface ImportEdge {
  from: string;
  to: string;
  specifier: string;
}

const IMPORT_PATTERN =
  /(?:import\s+(?:[\s\S]*?\s+from\s+)?|export\s+(?:\*|\{[\s\S]*?\})\s+from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'generated') continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Resolves a @/ alias or relative specifier to a path inside src/, if it is one. */
function resolve(fromFile: string, specifier: string): string | null {
  let base: string;

  if (specifier.startsWith('@/')) {
    base = join(SRC, specifier.slice(2));
  } else if (specifier.startsWith('.')) {
    base = join(fromFile, '..', specifier);
  } else {
    return null;
  }

  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
    base,
  ];

  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function buildGraph(): ImportEdge[] {
  const files = walk(SRC);
  const edges: ImportEdge[] = [];

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    let match: RegExpExecArray | null;

    IMPORT_PATTERN.lastIndex = 0;
    while ((match = IMPORT_PATTERN.exec(source)) !== null) {
      const specifier = match[1]!;
      const resolved = resolve(file, specifier);
      if (!resolved) continue;

      edges.push({ from: file, to: resolved, specifier });
    }
  }

  return edges;
}

const edges = buildGraph();
const rel = (p: string) => relative(SRC, p).split(sep).join('/');

describe('kernel import graph', () => {
  it('found the source tree', () => {
    expect(edges.length).toBeGreaterThan(50);
  });

  /**
   * The rule that matters. If lib/ ever imports from modules/ or app/, the
   * posting engine stops being reusable: Phase 2 would have to reach back into
   * Phase 1's feature code, and the core would stop being a kernel.
   */
  it('lib/ never imports from modules/ or app/', () => {
    const violations = edges.filter(
      (edge) =>
        rel(edge.from).startsWith('lib/') &&
        (rel(edge.to).startsWith('modules/') || rel(edge.to).startsWith('app/')),
    );

    expect(violations.map((v) => `${rel(v.from)} -> ${rel(v.to)} (${v.specifier})`)).toEqual([]);
  });

  /**
   * Cross-module interaction goes through the kernel. Two modules sharing a
   * private helper by importing each other's server/ directory is how a system
   * turns into a set of pages that share state instead of a system.
   *
   * This rule has already caught one real violation: the audit-trail module
   * reaching into users-roles to call its chain-verification action.
   */
  it('a module never imports another module internals', () => {
    const violations = edges.filter((edge) => {
      const from = rel(edge.from);
      const to = rel(edge.to);
      if (!from.startsWith('modules/') || !to.startsWith('modules/')) return false;

      const fromModule = from.split('/')[1];
      const toModule = to.split('/')[1];
      return fromModule !== toModule;
    });

    expect(violations.map((v) => `${rel(v.from)} -> ${rel(v.to)} (${v.specifier})`)).toEqual([]);
  });

  /**
   * Modules must go through lib/db, which carries the tenant filter and the
   * shared client. A direct @prisma/client import inside a module is the specific
   * way a tenant filter gets silently skipped.
   */
  it('modules do not import @prisma/client directly', () => {
    const violations = edges.filter(
      (edge) => rel(edge.from).startsWith('modules/') && edge.specifier === '@prisma/client',
    );

    expect(violations.map((v) => rel(v.from))).toEqual([]);
  });

  it('lib/ does not reach into the presentation layer', () => {
    const violations = edges.filter(
      (edge) =>
        rel(edge.from).startsWith('lib/') &&
        (rel(edge.to).startsWith('modules/') || rel(edge.to).startsWith('components/')),
    );

    expect(violations).toEqual([]);
  });

  /**
   * Exactly one place may touch the generated client. Everywhere else goes
   * through lib/db, which is where the singleton and the tenant extension live.
   */
  it('only lib/db imports the generated Prisma client', () => {
    const violations = edges.filter(
      (edge) =>
        edge.specifier.includes('generated/prisma') && !rel(edge.from).startsWith('lib/db/'),
    );

    expect(violations.map((v) => `${rel(v.from)} -> ${v.specifier}`)).toEqual([]);
  });
});
