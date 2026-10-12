import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';

function daysPastDue(dueAt: Date, now: Date): number {
  const startDue = Date.UTC(dueAt.getUTCFullYear(), dueAt.getUTCMonth(), dueAt.getUTCDate());
  const startNow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((startNow - startDue) / 86_400_000);
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'CUSTOMERS', action: 'VIEW' });
    if (!ctx.actor.organizationId) return apiError(new ValidationError('No organization context'), reqId);
    const { id } = await params;
    const customer = await prisma.customer.findFirst({ where: { id, organizationId: ctx.actor.organizationId, deletedAt: null }, select: { id: true, currencyCode: true, status: true, riskLevel: true, creditHoldReason: true } });
    if (!customer) return apiError(new NotFoundError('Customer', id), reqId);
    const receivables = await prisma.customerReceivable.findMany({
      where: { organizationId: ctx.actor.organizationId, customerId: id, currencyCode: customer.currencyCode, status: { in: ['OPEN', 'PARTIALLY_PAID'] } },
      orderBy: [{ dueAt: 'asc' }, { issuedAt: 'asc' }],
      select: { id: true, invoiceReference: true, invoiceId: true, sourceJournalEntryId: true, currencyCode: true, originalAmount: true, outstandingAmount: true, issuedAt: true, dueAt: true, status: true },
    });
    const now = new Date();
    const buckets = { current: new Prisma.Decimal(0), days0To30: new Prisma.Decimal(0), days31To60: new Prisma.Decimal(0), days61To90: new Prisma.Decimal(0), days90Plus: new Prisma.Decimal(0) };
    const overdueInvoices = [] as Array<typeof receivables[number] & { daysPastDue: number }>;
    let total = new Prisma.Decimal(0);
    for (const receivable of receivables) {
      const amount = receivable.outstandingAmount;
      total = total.plus(amount);
      const age = daysPastDue(receivable.dueAt, now);
      if (age <= 0) buckets.current = buckets.current.plus(amount);
      else if (age <= 30) buckets.days0To30 = buckets.days0To30.plus(amount);
      else if (age <= 60) buckets.days31To60 = buckets.days31To60.plus(amount);
      else if (age <= 90) buckets.days61To90 = buckets.days61To90.plus(amount);
      else buckets.days90Plus = buckets.days90Plus.plus(amount);
      if (age > 0) overdueInvoices.push({ ...receivable, daysPastDue: age });
    }
    const sourceEntryIds = [...new Set(receivables.flatMap((receivable) => receivable.sourceJournalEntryId ? [receivable.sourceJournalEntryId] : []))];
    const ledgerLines = sourceEntryIds.length > 0 ? await prisma.journalLine.findMany({
      where: {
        organizationId: ctx.actor.organizationId,
        entryId: { in: sourceEntryIds },
        currencyCode: customer.currencyCode,
        entry: { status: 'POSTED' },
        account: { subCategory: 'RECEIVABLE' },
      },
      select: { debit: true, credit: true },
    }) : [];
    const ledgerBalance = ledgerLines.reduce((sum, line) => sum.plus(line.debit).minus(line.credit), new Prisma.Decimal(0));
    const allReceivablesLinked = receivables.every((receivable) => receivable.sourceJournalEntryId !== null);
    const ledgerReconciliation = sourceEntryIds.length === 0 ? { status: 'UNLINKED' as const, ledgerBalance: null, difference: null, matches: null } : {
      status: allReceivablesLinked ? 'LINKED' as const : 'PARTIALLY_LINKED' as const,
      ledgerBalance: ledgerBalance.toString(),
      difference: allReceivablesLinked ? total.minus(ledgerBalance).toString() : null,
      matches: allReceivablesLinked ? total.equals(ledgerBalance) : null,
    };
    const alerts: string[] = [];
    if (customer.status === 'CREDIT_HOLD') alerts.push(customer.creditHoldReason ?? 'Customer is on credit hold.');
    if (customer.status === 'BLOCKED') alerts.push('Customer is blocked from invoicing.');
    if (customer.riskLevel === 'HIGH' || customer.riskLevel === 'CRITICAL') alerts.push(`Customer risk level is ${customer.riskLevel}.`);
    if (overdueInvoices.length > 0) alerts.push(`${overdueInvoices.length} invoice(s) are overdue.`);
    return ok({
      data: {
        customerId: id,
        currencyCode: customer.currencyCode,
        asOf: now.toISOString(),
        buckets: Object.fromEntries(Object.entries(buckets).map(([key, value]) => [key, value.toString()])),
        totalOutstanding: total.toString(),
        overdueCount: overdueInvoices.length,
        overdueInvoices,
        riskAlerts: alerts,
        ledgerReconciliation,
      },
    }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
