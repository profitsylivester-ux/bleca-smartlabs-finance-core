import { Prisma } from '@/generated/prisma/client';
import { authorize } from '@/lib/kernel/authorize';
import type { RequestContext } from '@/lib/kernel/context';
import { prisma } from '@/lib/db/prisma';
import { invoiceOutstanding, organizationIdOf } from './common';

type AgingBucket = 'CURRENT' | 'DAYS_1_30' | 'DAYS_31_60' | 'DAYS_61_90' | 'DAYS_91_PLUS';

function bucketFor(dueDate: Date, asOf: Date): { bucket: AgingBucket; daysPastDue: number } {
  const due = Date.UTC(dueDate.getUTCFullYear(), dueDate.getUTCMonth(), dueDate.getUTCDate());
  const today = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  const daysPastDue = Math.max(0, Math.floor((today - due) / 86_400_000));
  if (due >= today) return { bucket: 'CURRENT', daysPastDue: 0 };
  if (daysPastDue <= 30) return { bucket: 'DAYS_1_30', daysPastDue };
  if (daysPastDue <= 60) return { bucket: 'DAYS_31_60', daysPastDue };
  if (daysPastDue <= 90) return { bucket: 'DAYS_61_90', daysPastDue };
  return { bucket: 'DAYS_91_PLUS', daysPastDue };
}

export async function getAgingReport(ctx: RequestContext, direction: 'RECEIVABLE' | 'PAYABLE', asOf = new Date()) {
  await authorize(ctx, { module: 'REPORTS', action: 'VIEW' });
  const organizationId = organizationIdOf(ctx);
  const invoices = await prisma.invoice.findMany({
    where: {
      organizationId,
      direction,
      status: { in: ['SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE'] },
      invoiceDate: { lte: asOf },
    },
    include: {
      customer: { include: { party: { select: { displayName: true } } } },
      supplier: { include: { party: { select: { displayName: true } } } },
    },
    orderBy: [{ dueDate: 'asc' }, { invoiceDate: 'asc' }, { number: 'asc' }],
  });
  const buckets = new Map<string, Record<AgingBucket, Prisma.Decimal>>();
  const rows = [];
  for (const invoice of invoices) {
    const balance = await invoiceOutstanding(prisma, invoice.id, invoice.totalAmount);
    if (!balance.outstanding.greaterThan(0)) continue;
    const { bucket, daysPastDue } = bucketFor(invoice.dueDate, asOf);
    const group = buckets.get(invoice.currencyCode) ?? {
      CURRENT: new Prisma.Decimal(0), DAYS_1_30: new Prisma.Decimal(0), DAYS_31_60: new Prisma.Decimal(0),
      DAYS_61_90: new Prisma.Decimal(0), DAYS_91_PLUS: new Prisma.Decimal(0),
    };
    group[bucket] = group[bucket].plus(balance.outstanding);
    buckets.set(invoice.currencyCode, group);
    rows.push({
      invoiceId: invoice.id,
      number: invoice.number,
      partyName: invoice.customer?.party.displayName ?? invoice.supplier?.party.displayName ?? 'Unknown counterparty',
      invoiceDate: invoice.invoiceDate,
      dueDate: invoice.dueDate,
      currencyCode: invoice.currencyCode,
      originalAmount: invoice.totalAmount.toString(),
      paidAmount: balance.paid.toString(),
      outstandingAmount: balance.outstanding.toString(),
      daysPastDue,
      bucket,
    });
  }

  const accountCode = direction === 'RECEIVABLE' ? '1141' : '2111';
  const controlAccount = await prisma.account.findFirst({
    where: { organizationId, code: accountCode, isPostable: true, status: 'ACTIVE' },
    select: { id: true, code: true, name: true },
  });
  const ledgerByCurrency = new Map<string, { debits: Prisma.Decimal; credits: Prisma.Decimal }>();
  if (controlAccount) {
    const ledgerLines = await prisma.journalLine.findMany({
      where: { organizationId, accountId: controlAccount.id, entry: { status: 'POSTED' } },
      select: { currencyCode: true, debit: true, credit: true },
    });
    for (const line of ledgerLines) {
      const existing = ledgerByCurrency.get(line.currencyCode) ?? { debits: new Prisma.Decimal(0), credits: new Prisma.Decimal(0) };
      existing.debits = existing.debits.plus(line.debit);
      existing.credits = existing.credits.plus(line.credit);
      ledgerByCurrency.set(line.currencyCode, existing);
    }
  }
  const totals = [...buckets.entries()].map(([currencyCode, values]) => ({
    currencyCode,
    current: values.CURRENT.toString(),
    days1To30: values.DAYS_1_30.toString(),
    days31To60: values.DAYS_31_60.toString(),
    days61To90: values.DAYS_61_90.toString(),
    days91Plus: values.DAYS_91_PLUS.toString(),
    total: Object.values(values).reduce((sum, amount) => sum.plus(amount), new Prisma.Decimal(0)).toString(),
  }));
  const ledgerControlBalances = [...ledgerByCurrency.entries()].map(([currencyCode, value]) => ({
    currencyCode,
    balance: (direction === 'RECEIVABLE' ? value.debits.minus(value.credits) : value.credits.minus(value.debits)).toString(),
  }));
  return {
    direction,
    asOf,
    rows,
    totals,
    controlAccount,
    ledgerControlBalances,
    subledgerMatchesControl: totals.every((total) => {
      const control = ledgerControlBalances.find((entry) => entry.currencyCode === total.currencyCode);
      return control?.balance === total.total;
    }),
  };
}

const sequenceModel: Record<
  'QUOTATION' | 'INVOICE' | 'PAYMENT' | 'RECEIPT' | 'CREDIT_NOTE' | 'DEBIT_NOTE',
  { model: 'quotation' | 'invoice' | 'payment' | 'receipt' | 'creditNote' | 'debitNote'; prefix: string }
> = {
  QUOTATION: { model: 'quotation', prefix: 'QTN' },
  INVOICE: { model: 'invoice', prefix: 'INV' },
  PAYMENT: { model: 'payment', prefix: 'PAY' },
  RECEIPT: { model: 'receipt', prefix: 'RCP' },
  CREDIT_NOTE: { model: 'creditNote', prefix: 'CN' },
  DEBIT_NOTE: { model: 'debitNote', prefix: 'DN' },
} as const;

export async function getNumberingGaps(ctx: RequestContext) {
  await authorize(ctx, { module: 'REPORTS', action: 'VIEW' });
  const organizationId = organizationIdOf(ctx);
  const sequences = await prisma.documentSequence.findMany({ where: { organizationId }, orderBy: { type: 'asc' } });
  const results = [];
  for (const sequence of sequences) {
    const config = sequenceModel[sequence.type];
    const docs = await getDocumentNumbers(config.model, organizationId);
    const numbers = new Set(docs.map((number) => Number(number.replace(`${config.prefix}-`, ''))));
    const missing = [];
    for (let current = 1; current <= sequence.lastNumber; current += 1) {
      if (!numbers.has(current)) missing.push(`${config.prefix}-${String(current).padStart(6, '0')}`);
    }
    results.push({ type: sequence.type, lastNumber: sequence.lastNumber, missingNumbers: missing });
  }
  return { sequences: results, hasGaps: results.some((sequence) => sequence.missingNumbers.length > 0) };
}

async function getDocumentNumbers(model: 'quotation' | 'invoice' | 'payment' | 'receipt' | 'creditNote' | 'debitNote', organizationId: string) {
  switch (model) {
    case 'quotation': return (await prisma.quotation.findMany({ where: { organizationId }, select: { number: true } })).map((row) => row.number);
    case 'invoice': return (await prisma.invoice.findMany({ where: { organizationId }, select: { number: true } })).map((row) => row.number);
    case 'payment': return (await prisma.payment.findMany({ where: { organizationId }, select: { number: true } })).map((row) => row.number);
    case 'receipt': return (await prisma.receipt.findMany({ where: { organizationId }, select: { number: true } })).map((row) => row.number);
    case 'creditNote': return (await prisma.creditNote.findMany({ where: { organizationId }, select: { number: true } })).map((row) => row.number);
    case 'debitNote': return (await prisma.debitNote.findMany({ where: { organizationId }, select: { number: true } })).map((row) => row.number);
  }
}

