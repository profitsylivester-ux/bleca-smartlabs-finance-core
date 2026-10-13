import { prisma } from '@/lib/db/prisma';
import type { AnomalySeverity, AnomalyType } from '@/generated/prisma/client';

/**
 * Deterministic anomaly rules (M16, PDF §30 + §65).
 *
 * Flag-only: a rule writes AnomalyFlag rows and nothing else. No rule blocks,
 * rejects, holds or alters money. A named human must acknowledge before any
 * effect. There is deliberately no `accusedUserId` anywhere in this file.
 */

export interface RuleHit {
  rule: AnomalyType;
  severity: AnomalySeverity;
  entityType: 'PAYMENT' | 'INVOICE' | 'SUPPLIER' | 'USER' | 'JOURNAL_ENTRY';
  entityId: string;
  entityLabel: string;
  description: string;
  evidence: Record<string, string | number | boolean | null>;
  dedupeKey: string;
}

export async function detectDuplicates(organizationId: string): Promise<RuleHit[]> {
  const hits: RuleHit[] = [];
  const txns = await prisma.transaction.groupBy({
    by: ['amount', 'currencyCode', 'date'],
    where: { organizationId },
    _count: { _all: true },
    having: { amount: { _count: { gt: 1 } } },
  });
  for (const g of txns) {
    const rows = await prisma.transaction.findMany({
      where: { organizationId, amount: g.amount, currencyCode: g.currencyCode, date: g.date },
      select: { id: true, number: true, description: true },
      take: 10,
    });
    if (rows.length < 2) continue;
    for (const row of rows) {
      hits.push({
        rule: 'DUPLICATE_TRANSACTION',
        severity: 'MEDIUM',
        entityType: 'PAYMENT',
        entityId: row.id,
        entityLabel: row.number ?? row.id.slice(0, 8),
        description: `Possible duplicate: ${rows.length} transactions share amount ${g.amount.toString()} ${g.currencyCode} on ${g.date.toISOString().slice(0, 10)}.`,
        evidence: { amount: g.amount.toString(), currency: g.currencyCode, date: g.date.toISOString(), matchCount: rows.length },
        dedupeKey: `duplicate-transaction:${row.id}`,
      });
    }
  }
  const invoices = await prisma.invoice.groupBy({
    by: ['totalAmount', 'currencyCode', 'invoiceDate'],
    where: { organizationId },
    _count: { _all: true },
    having: { totalAmount: { _count: { gt: 1 } } },
  });
  for (const g of invoices) {
    const rows = await prisma.invoice.findMany({
      where: { organizationId, totalAmount: g.totalAmount, currencyCode: g.currencyCode, invoiceDate: g.invoiceDate },
      select: { id: true, number: true },
      take: 10,
    });
    if (rows.length < 2) continue;
    for (const row of rows) {
      hits.push({
        rule: 'DUPLICATE_INVOICE',
        severity: 'MEDIUM',
        entityType: 'INVOICE',
        entityId: row.id,
        entityLabel: row.number,
        description: `Possible duplicate: ${rows.length} invoices share total ${g.totalAmount.toString()} ${g.currencyCode} on ${g.invoiceDate.toISOString().slice(0, 10)}.`,
        evidence: { amount: g.totalAmount.toString(), currency: g.currencyCode, date: g.invoiceDate.toISOString(), matchCount: rows.length },
        dedupeKey: `duplicate-invoice:${row.id}`,
      });
    }
  }
  return hits;
}
