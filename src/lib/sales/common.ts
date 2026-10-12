import { Prisma } from '@/generated/prisma/client';
import type { RequestContext } from '@/lib/kernel/context';
import { withAudit, type AuditContext } from '@/lib/db/with-audit';
import type { Tx } from '@/lib/db/prisma';
import { postJournalEntry } from '@/lib/accounting/posting';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';
import { writeAuditEntry } from '@/lib/audit/writer';

export function organizationIdOf(ctx: RequestContext): string {
  const organizationId = ctx.actor.organizationId;
  if (!organizationId) throw new ValidationError('An organization context is required.');
  return organizationId;
}

export function auditContextOf(ctx: RequestContext): AuditContext {
  return {
    organizationId: ctx.actor.organizationId,
    actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
    sessionId: ctx.actor.sessionId,
  };
}

export function withSalesAudit<T>(ctx: RequestContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withAudit(auditContextOf(ctx), fn);
}

export async function auditSalesChange(
  tx: Tx,
  ctx: RequestContext,
  entry: Parameters<typeof writeAuditEntry>[2],
): Promise<void> {
  await writeAuditEntry(
    tx,
    { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
    entry,
    {
      organizationId: organizationIdOf(ctx),
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
      sessionId: ctx.actor.sessionId,
    },
  );
}

const sequencePrefix = {
  QUOTATION: 'QTN',
  INVOICE: 'INV',
  PAYMENT: 'PAY',
  RECEIPT: 'RCP',
  CREDIT_NOTE: 'CN',
  DEBIT_NOTE: 'DN',
} as const;

export async function nextDocumentNumber(
  tx: Tx,
  organizationId: string,
  type: keyof typeof sequencePrefix,
): Promise<string> {
  const sequence = await tx.documentSequence.upsert({
    where: { organizationId_type: { organizationId, type } },
    create: { organizationId, type, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
    select: { lastNumber: true },
  });
  return `${sequencePrefix[type]}-${String(sequence.lastNumber).padStart(6, '0')}`;
}

export async function assertCurrency(tx: Tx, currencyCode: string): Promise<void> {
  const currency = await tx.currency.findUnique({ where: { code: currencyCode }, select: { code: true } });
  if (!currency) throw new NotFoundError('Currency', currencyCode);
}

export async function findOpenPeriod(tx: Tx, organizationId: string, date: Date) {
  const period = await tx.financialPeriod.findFirst({
    where: {
      organizationId,
      type: 'MONTHLY',
      status: { in: ['OPEN', 'REOPENED'] },
      startDate: { lte: date },
      endDate: { gte: date },
    },
    orderBy: { startDate: 'desc' },
    select: { id: true, status: true, code: true },
  });
  if (!period) {
    throw new ValidationError(`No open monthly financial period contains ${date.toISOString().slice(0, 10)}.`);
  }
  return period;
}

export async function findControlAccount(
  tx: Tx,
  organizationId: string,
  kind: 'RECEIVABLE' | 'PAYABLE',
) {
  const account = await tx.account.findFirst({
    where: {
      organizationId,
      code: kind === 'RECEIVABLE' ? '1141' : '2111',
      isPostable: true,
      status: 'ACTIVE',
    },
    select: { id: true, code: true, name: true, type: true, subCategory: true },
  });
  if (!account) {
    throw new ValidationError(`The active ${kind === 'RECEIVABLE' ? 'trade receivables' : 'trade payables'} control account is not configured.`);
  }
  return account;
}

export interface JournalLineInput {
  accountId: string;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  description: string;
}

export async function createAndPostJournalEntry(
  tx: Tx,
  ctx: RequestContext,
  input: {
    organizationId: string;
    date: Date;
    currencyCode: string;
    source: 'INVOICE' | 'PAYMENT' | 'CREDIT_NOTE' | 'DEBIT_NOTE' | 'REVERSAL';
    reference: string;
    description: string;
    submittedById: string;
    lines: JournalLineInput[];
    reversedEntryId?: string;
  },
): Promise<string> {
  const period = await findOpenPeriod(tx, input.organizationId, input.date);
  if (input.lines.length < 2) throw new ValidationError('A posted document must produce at least two journal lines.');

  const totals = input.lines.reduce(
    (result, line) => ({ debit: result.debit.plus(line.debit), credit: result.credit.plus(line.credit) }),
    { debit: new Prisma.Decimal(0), credit: new Prisma.Decimal(0) },
  );
  if (!totals.debit.equals(totals.credit) || totals.debit.isZero()) {
    throw new ValidationError('The document journal entry is not balanced.');
  }

  const entry = await tx.journalEntry.create({
    data: {
      organizationId: input.organizationId,
      periodId: period.id,
      type: input.reversedEntryId ? 'REVERSAL' : 'SYSTEM',
      status: 'APPROVED',
      source: input.source,
      reference: input.reference,
      description: input.description,
      submittedById: input.submittedById,
      submittedAt: new Date(),
      approvedById: ctx.actor.userId,
      approvedAt: new Date(),
      reversedEntryId: input.reversedEntryId,
      lines: {
        create: input.lines.map((line, index) => ({
          organizationId: input.organizationId,
          accountId: line.accountId,
          lineNumber: index + 1,
          description: line.description,
          debit: line.debit,
          credit: line.credit,
          currencyCode: input.currencyCode,
          baseAmount: line.debit.plus(line.credit),
        })),
      },
    },
    select: { id: true },
  });

  await postJournalEntry(tx, {
    entryId: entry.id,
    actorId: ctx.actor.userId,
    actorName: ctx.actor.fullName,
    actorRoleCodes: ctx.actor.roleCodes,
    organizationId: input.organizationId,
    idempotencyKey: ctx.idempotencyKey ?? ctx.requestId,
  });
  return entry.id;
}

export async function reversePostedJournalEntry(
  tx: Tx,
  ctx: RequestContext,
  organizationId: string,
  entryId: string,
  date: Date,
  reference: string,
  reason: string,
): Promise<string> {
  const original = await tx.journalEntry.findFirst({
    where: { id: entryId, organizationId, status: 'POSTED' },
    include: { lines: { orderBy: { lineNumber: 'asc' } } },
  });
  if (!original) throw new NotFoundError('Posted journal entry', entryId);

  const reversalId = await createAndPostJournalEntry(tx, ctx, {
    organizationId,
    date,
    currencyCode: original.lines[0]?.currencyCode ?? 'TZS',
    source: 'REVERSAL',
    reference,
    description: `Reversal of ${original.reference ?? original.id}: ${reason}`,
    submittedById: original.submittedById ?? ctx.actor.userId,
    reversedEntryId: original.id,
    lines: original.lines.map((line) => ({
      accountId: line.accountId,
      debit: line.credit,
      credit: line.debit,
      description: `Reversal: ${line.description ?? original.description ?? reference}`,
    })),
  });
  await tx.journalEntry.update({ where: { id: original.id }, data: { status: 'REVERSED' } });
  return reversalId;
}

export async function invoiceOutstanding(tx: Tx, invoiceId: string, totalAmount: Prisma.Decimal) {
  const [payments, credits, debits] = await Promise.all([
    tx.paymentAllocation.aggregate({
      where: { invoiceId, payment: { status: 'COMPLETED' } },
      _sum: { amount: true },
    }),
    tx.creditNote.aggregate({ where: { invoiceId, status: 'APPLIED' }, _sum: { amount: true, taxAmount: true } }),
    tx.debitNote.aggregate({ where: { invoiceId, status: 'APPLIED' }, _sum: { amount: true, taxAmount: true } }),
  ]);
  const paid = payments._sum.amount ?? new Prisma.Decimal(0);
  const credited = (credits._sum.amount ?? new Prisma.Decimal(0)).plus(credits._sum.taxAmount ?? 0);
  const debited = (debits._sum.amount ?? new Prisma.Decimal(0)).plus(debits._sum.taxAmount ?? 0);
  return { paid, credited, debited, outstanding: totalAmount.minus(paid).minus(credited).plus(debited) };
}

export async function syncInvoiceStatusAndReceivable(tx: Tx, invoiceId: string, organizationId: string) {
  const invoice = await tx.invoice.findFirst({
    where: { id: invoiceId, organizationId },
    select: {
      id: true,
      number: true,
      direction: true,
      status: true,
      customerId: true,
      currencyCode: true,
      totalAmount: true,
      invoiceDate: true,
      dueDate: true,
      journalEntryId: true,
    },
  });
  if (!invoice || invoice.status === 'CANCELLED') return;
  const balance = await invoiceOutstanding(tx, invoice.id, invoice.totalAmount);
  const nextStatus = balance.outstanding.lte(0)
    ? 'PAID'
    : balance.paid.greaterThan(0) || balance.credited.greaterThan(0)
      ? 'PARTIALLY_PAID'
      : invoice.dueDate < new Date()
        ? 'OVERDUE'
        : 'SENT';
  if (invoice.status !== nextStatus) {
    await tx.invoice.update({ where: { id: invoice.id }, data: { status: nextStatus } });
  }

  if (invoice.direction === 'RECEIVABLE' && invoice.customerId) {
    const status = balance.outstanding.lte(0)
      ? 'PAID'
      : balance.paid.greaterThan(0) || balance.credited.greaterThan(0)
        ? 'PARTIALLY_PAID'
        : 'OPEN';
    const receivable = await tx.customerReceivable.findFirst({
      where: { organizationId, invoiceId: invoice.id },
      select: { id: true },
    });
    if (receivable) {
      await tx.customerReceivable.update({
        where: { id: receivable.id },
        data: { outstandingAmount: balance.outstanding, status },
      });
    } else if (invoice.journalEntryId) {
      await tx.customerReceivable.create({
        data: {
          organizationId,
          customerId: invoice.customerId,
          invoiceId: invoice.id,
          invoiceReference: invoice.number,
          sourceJournalEntryId: invoice.journalEntryId,
          currencyCode: invoice.currencyCode,
          originalAmount: invoice.totalAmount,
          outstandingAmount: balance.outstanding,
          issuedAt: invoice.invoiceDate,
          dueAt: invoice.dueDate,
          status,
        },
      });
    }
  }
}

export function decimal(value: string | number | Prisma.Decimal): Prisma.Decimal {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

