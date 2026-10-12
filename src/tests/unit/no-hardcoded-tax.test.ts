import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

/**
 * M13 guard: no Tanzanian tax value may appear in application code.
 * Rates, thresholds and registration identifiers are configuration rows,
 * so a statutory change is a data edit rather than a deploy.
 */

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

const SCOPED_FILES = new Set([
  'tests/unit/no-hardcoded-tax.test.ts',
  'tests/integration/m13-tax-compliance.test.ts',
]);

function inScope(path: string): boolean {
  const rel = relative(SRC, path).split(sep).join('/');
  if (SCOPED_FILES.has(rel)) return false;
  if (rel.startsWith('tests/')) return false;
  return true;
}

describe('no hardcoded Tanzanian tax values', () => {
  it('keeps rates, thresholds and identifiers out of source', () => {
    const violations: string[] = [];
    const ratePattern = /\brate\s*(percent)?\s*[:=]\s*['"]?\d+(\.\d+)?['"]?/i;
    const identifierPattern = /\btin\b\s*[:=]\s*['"]\d/i;

    for (const file of walk(SRC).filter(inScope)) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file).split(sep).join('/');
      const lines = source.split('\n');
      lines.forEach((line, index) => {
        const stripped = line.trim();
        if (!stripped || stripped.startsWith('//') || stripped.startsWith('*')) return;
        if (ratePattern.test(line) && /ratePercent|taxRate|rate/i.test(line)) {
          violations.push(`${rel}:${index + 1}: hardcoded rate literal`);
        }
        if (identifierPattern.test(line)) {
          violations.push(`${rel}:${index + 1}: hardcoded TIN literal`);
        }
      });
    }

    expect(violations).toEqual([]);
  });

  it('never computes tax from a literal instead of a configured rule', () => {
    const violations: string[] = [];
    for (const file of walk(SRC).filter(inScope)) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file).split(sep).join('/');
      if (rel.startsWith('lib/tax-compliance/')) continue;
      if (/taxAmount|tax_amount/.test(source) && /times\s*\(\s*0\.\d+|\*\s*0\.\d+/.test(source)) {
        violations.push(`${rel}: inline tax factor`);
      }
    }
    expect(violations).toEqual([]);
  });
});
