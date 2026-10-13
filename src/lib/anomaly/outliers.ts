import { prisma } from '@/lib/db/prisma';
import { Decimal } from '@prisma/client/runtime/library';
import type { RuleHit } from './rules';

/**
 * Amount-outlier, weekend, late-night and rounding-pattern rules.
 * Pure thresholds over posted transactions — no model calls.
 */

export async function detectOutliers(organizationId: string): Promise<RuleHit[]> {
  const hits: RuleHit[] = [];
  const rows = await prisma.transaction.findMany({
    where: { organizationId, status: { in: ['POSTED', 'LOCKED', 'APPROVED'] } },
    select: { id: true, number: true, amount: true, currencyCode: true, date: true, createdAt: true },
    take: 2000,
    orderBy: { createdAt: 'desc' },
  });
  if (rows.length < 5) return hits;
  const amounts = rows.map((r) => new Decimal(r.amount.toString()));
  const mean = amounts.reduce((s, a) => s.plus(a), new Decimal(0)).div(amounts.length);
  const variance = amounts.reduce((s, a) => s.plus(a.minus(mean).pow(2)), new Decimal(0)).div(amounts.length);
  const std = variance.sqrt();
  const threshold = mean.plus(std.times(3));
  for (const row of rows) {
    const amount = new Decimal(row.amount.toString());
    if (amount.greaterThan(threshold) && threshold.greaterThan(0)) {
      hits.push({
        rule: 'AMOUNT_OUTLIER',
        severity: 'HIGH',
        entityType: 'PAYMENT',
        entityId: row.id,
        entityLabel: row.number ?? row.id.slice(0, 8),
        description: `Amount ${amount.toString()} ${row.currencyCode} exceeds 3σ above the mean (${mean.toFixed(2)}). Flag for review — not blocked.`,
        evidence: { amount: amount.toString(), mean: mean.toFixed(2), stdDev: std.toFixed(2), threshold: threshold.toFixed(2) },
        dedupeKey: `amount-outlier:${row.id}`,
      });
    }
    const day = row.date.getUTCDay();
    if (day === 0 || day === 6) {
      hits.push({
        rule: 'WEEKEND_TRANSACTION',
        severity: 'LOW',
        entityType: 'PAYMENT',
        entityId: row.id,
        entityLabel: row.number ?? row.id.slice(0, 8),
        description: `Transaction dated on a weekend (${row.date.toISOString().slice(0, 10)}). Flag for review — not blocked.`,
        evidence: { date: row.date.toISOString(), weekday: day },
        dedupeKey: `weekend-transaction:${row.id}`,
      });
    }
    const hour = row.createdAt.getUTCHours();
    if (hour < 5 || hour >= 23) {
      hits.push({
        rule: 'LATE_NIGHT_ACTIVITY',
        severity: 'LOW',
        entityType: 'PAYMENT',
        entityId: row.id,
        entityLabel: row.number ?? row.id.slice(0, 8),
        description: `Transaction recorded at ${String(hour).padStart(2, '0')}:00 UTC — outside normal hours. Flag for review.`,
        evidence: { createdAt: row.createdAt.toISOString(), hour },
        dedupeKey: `late-night:${row.id}`,
      });
    }
    const remainder = amount.modulo(1000);
    if (amount.greaterThan(0) && remainder.equals(0)) {
      hits.push({
        rule: 'ROUNDING_PATTERN',
        severity: 'LOW',
        entityType: 'PAYMENT',
        entityId: row.id,
        entityLabel: row.number ?? row.id.slice(0, 8),
        description: `Round-figure amount ${amount.toString()} ${row.currencyCode}. Flag for review — not blocked.`,
        evidence: { amount: amount.toString() },
        dedupeKey: `rounding-pattern:${row.id}`,
      });
    }
  }
  return hits;
}
