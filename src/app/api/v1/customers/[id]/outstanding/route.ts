import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'CUSTOMERS', action: 'VIEW' });
    if (!ctx.actor.organizationId) return apiError(new ValidationError('No organization context'), reqId);
    const { id } = await params;
    const customer = await prisma.customer.findFirst({ where: { id, organizationId: ctx.actor.organizationId, deletedAt: null }, select: { id: true, currencyCode: true } });
    if (!customer) return apiError(new NotFoundError('Customer', id), reqId);
    const receivables = await prisma.customerReceivable.findMany({
      where: { organizationId: ctx.actor.organizationId, customerId: id, status: { in: ['OPEN', 'PARTIALLY_PAID'] } },
      orderBy: [{ dueAt: 'asc' }, { issuedAt: 'asc' }],
      select: { id: true, invoiceId: true, invoiceReference: true, currencyCode: true, originalAmount: true, outstandingAmount: true, issuedAt: true, dueAt: true, status: true, sourceJournalEntryId: true },
    });
    const totals = new Map<string, Prisma.Decimal>();
    for (const row of receivables) totals.set(row.currencyCode, (totals.get(row.currencyCode) ?? new Prisma.Decimal(0)).plus(row.outstandingAmount));
    return ok({
      data: {
        customerId: id,
        currencyCode: customer.currencyCode,
        outstandingByCurrency: Object.fromEntries([...totals.entries()].map(([code, amount]) => [code, amount.toString()])),
        invoiceCount: receivables.length,
        receivables,
      },
    }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
