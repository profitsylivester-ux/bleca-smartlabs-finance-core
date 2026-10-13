import { prisma } from '@/lib/db/prisma';
import type { RuleHit } from './rules';

/**
 * Supplier-bank-detail-changed-then-paid (PDF §23 fraud pattern).
 *
 * Deterministic join: a payment to a supplier whose active bank detail row was
 * created (changed) within the lookback window before the payment date. The
 * hit flags the PAYMENT; the subject is the record, never a person.
 */

const LOOKBACK_DAYS = 14;

export async function detectSupplierChangeThenPaid(organizationId: string, now = new Date()): Promise<RuleHit[]> {
  const hits: RuleHit[] = [];
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000);
  const payments = await prisma.payment.findMany({
    where: { organizationId, direction: 'OUTBOUND', status: { in: ['APPROVED', 'COMPLETED'] }, paymentDate: { gte: since } },
    select: { id: true, number: true, amount: true, currencyCode: true, paymentDate: true, supplierId: true },
    take: 500,
    orderBy: { paymentDate: 'desc' },
  });
  for (const payment of payments) {
    if (!payment.supplierId) continue;
    const freshDetail = await prisma.supplierBankDetail.findFirst({
      where: {
        supplierId: payment.supplierId,
        isActive: true,
        createdAt: { lte: payment.paymentDate, gte: new Date(payment.paymentDate.getTime() - LOOKBACK_DAYS * 86_400_000) },
      },
      select: { id: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!freshDetail) continue;
    hits.push({
      rule: 'SUSPICIOUS_PAYMENT_CHANGE',
      severity: 'CRITICAL',
      entityType: 'PAYMENT',
      entityId: payment.id,
      entityLabel: payment.number ?? payment.id.slice(0, 8),
      description: `Payment of ${payment.amount.toString()} ${payment.currencyCode} made within ${LOOKBACK_DAYS} days of a supplier bank detail change. Verify the beneficiary before releasing further funds — this flag blocks nothing by itself.`,
      evidence: {
        paymentId: payment.id,
        supplierId: payment.supplierId,
        bankDetailId: freshDetail.id,
        bankDetailCreatedAt: freshDetail.createdAt.toISOString(),
        paymentDate: payment.paymentDate.toISOString(),
        lookbackDays: LOOKBACK_DAYS,
      },
      dedupeKey: `supplier-change-then-paid:${payment.id}:${freshDetail.id}`,
    });
  }
  return hits;
}

export async function detectSodViolations(organizationId: string): Promise<RuleHit[]> {
  const hits: RuleHit[] = [];
  const attempts = await prisma.securityEvent.findMany({
    where: { organizationId, type: 'SOD_VIOLATION_ATTEMPT', acknowledgedAt: null },
    select: { id: true, subjectId: true, subjectLabel: true, description: true, occurredAt: true },
    take: 100,
    orderBy: { occurredAt: 'desc' },
  });
  for (const event of attempts) {
    hits.push({
      rule: 'SOD_VIOLATION',
      severity: 'HIGH',
      entityType: 'PAYMENT',
      entityId: event.subjectId ?? event.id,
      entityLabel: event.subjectLabel ?? event.id.slice(0, 8),
      description: `Segregation-of-duties violation attempt: ${event.description}`,
      evidence: { securityEventId: event.id, occurredAt: event.occurredAt.toISOString() },
      dedupeKey: `sod-violation:${event.id}`,
    });
  }
  return hits;
}
