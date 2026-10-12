import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '@/generated/prisma/client';
import type { RequestContext } from '@/lib/kernel/context';
import { prisma } from '@/lib/db/prisma';
import { seedTestFixtures } from '../setup/fixtures';
import { createQuotation, submitQuotation, decideQuotation, sendQuotation, acceptQuotation, convertQuotation } from '@/lib/sales/quotations';
import { createInvoice, submitInvoice, decideInvoice, sendInvoice, cancelInvoice } from '@/lib/sales/invoices';
import { createPayment, submitPayment, decidePayment, completePayment } from '@/lib/sales/payments';
import { createCreditNote, submitCreditNote, decideCreditNote } from '@/lib/sales/notes';
import { ConflictError } from '@/lib/kernel/errors';

const db = new PrismaClient();
const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const today = new Date();
const dateOnly = today.toISOString().slice(0, 10);
const dueDate = new Date(today.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
let organizationId: string;
let revenueAccountId: string;
let expenseAccountId: string;
let receivableAccountId: string;
let treasuryAccountId: string;
let postingPeriodId: string;
let maker: TestActor;
let secondFinance: TestActor;
let ceo: TestActor;

interface TestActor {
  id: string;
  email: string;
  fullName: string;
  roleCode: string;
  isFinalApprover: boolean;
}

beforeAll(async () => {
  await seedTestFixtures(db);
  const organization = await db.organization.findUniqueOrThrow({ where: { code: 'BLECA' }, select: { id: true } });
  organizationId = organization.id;
  const [financeRole, ceoRole, revenue, expense, receivable, bankAccount] = await Promise.all([
    db.role.findUniqueOrThrow({ where: { code: 'FINANCE_OFFICER' }, select: { id: true } }),
    db.role.findUniqueOrThrow({ where: { code: 'CEO' }, select: { id: true, isFinalApprover: true } }),
    db.account.findFirstOrThrow({ where: { organizationId, type: 'REVENUE', status: 'ACTIVE', isPostable: true }, select: { id: true } }),
    db.account.findFirstOrThrow({ where: { organizationId, type: 'EXPENSE', status: 'ACTIVE', isPostable: true }, select: { id: true } }),
    db.account.findFirstOrThrow({ where: { organizationId, code: '1141', status: 'ACTIVE', isPostable: true }, select: { id: true } }),
    db.account.findFirstOrThrow({ where: { organizationId, type: 'ASSET', status: 'ACTIVE', isPostable: true, subCategory: { in: ['BANK', 'CASH'] } }, select: { id: true } }),
  ]);
  maker = await createActor('maker', financeRole.id, 'FINANCE_OFFICER', false);
  secondFinance = await createActor('poster', financeRole.id, 'FINANCE_OFFICER', false);
  ceo = await createActor('ceo', ceoRole.id, 'CEO', ceoRole.isFinalApprover);
  revenueAccountId = revenue.id;
  expenseAccountId = expense.id;
  receivableAccountId = receivable.id;
  const treasury = await db.treasuryAccount.create({
    data: {
      organizationId, code: `M11-${suffix}`, name: 'M11 integration bank account', kind: 'BANK',
      currencyCode: 'TZS', ledgerAccountId: bankAccount.id,
    }, select: { id: true },
  });
  treasuryAccountId = treasury.id;

  const periodStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0, 23, 59, 59));
  const postingPeriod = await db.financialPeriod.create({
    data: { organizationId, type: 'MONTHLY', status: 'OPEN', code: `M11-${suffix}`, name: `M11 integration ${suffix}`, startDate: periodStart, endDate: periodEnd },
    select: { id: true },
  });
  postingPeriodId = postingPeriod.id;
});

afterAll(async () => {
  await db.financialPeriod.update({ where: { id: postingPeriodId }, data: { type: 'ANNUAL' } });
  await db.$disconnect();
  await prisma.$disconnect();
});

describe('M11 sales and purchases', () => {
  it('runs quotation → invoice → payment → receipt without recognizing revenue at quotation stage', async () => {
    const customer = await createCustomer();
    const quotation = await createQuotation(context(maker), {
      customerId: customer.id, quoteDate: dateOnly, validUntil: dueDate, currencyCode: 'TZS',
      lines: [{ description: 'M11 consulting service', quantity: 1, unitPrice: 100 }],
    });
    expect(quotation.number).toMatch(/^QTN-/);
    expect(await db.journalEntry.count({ where: { organizationId, source: 'INVOICE', reference: quotation.number } })).toBe(0);

    await submitQuotation(context(maker), quotation.id);
    await decideQuotation(context(ceo), quotation.id, 'APPROVED');
    await sendQuotation(context(secondFinance), quotation.id);
    await acceptQuotation(context(secondFinance), quotation.id);
    const quoteLines = await db.quotationLine.findMany({ where: { quotationId: quotation.id }, select: { id: true, quantity: true } });
    const conversion = await convertQuotation(context(maker), quotation.id, {
      invoices: [{ invoiceDate: dateOnly, dueDate, lines: [{ quotationLineId: quoteLines[0]!.id, quantity: '1', accountId: revenueAccountId }] }],
    });
    const invoice = conversion!.invoices[0]!;
    expect(invoice.status).toBe('DRAFT');
    expect(await db.journalEntry.count({ where: { organizationId, source: 'INVOICE', reference: invoice.number } })).toBe(0);

    await submitInvoice(context(maker), invoice.id);
    await decideInvoice(context(ceo), invoice.id, 'APPROVED');
    const postedInvoice = await sendInvoice(context(secondFinance), invoice.id);
    expect(postedInvoice.status).toBe('SENT');
    expect(postedInvoice.journalEntryId).toBeTruthy();
    await expectBalancedEntry(postedInvoice.journalEntryId!);

    const payment = await createPayment(context(maker), {
      direction: 'INBOUND', customerId: customer.id, treasuryAccountId, currencyCode: 'TZS', amount: 100,
      paymentDate: dateOnly, methods: [{ method: 'BANK_TRANSFER', amount: 60 }, { method: 'CASH', amount: 40 }],
    });
    await submitPayment(context(maker), payment.id);
    await decidePayment(context(ceo), payment.id, 'APPROVED');
    const completed = await completePayment(context(secondFinance), payment.id);
    expect(completed.status).toBe('COMPLETED');
    expect(completed.receipt?.number).toMatch(/^RCP-/);
    await expectBalancedEntry(completed.journalEntryId!);
    const receipt = await db.receipt.findUniqueOrThrow({ where: { paymentId: payment.id }, include: { lines: true } });
    expect(receipt.status).toBe('ISSUED');
    expect(receipt.lines).toHaveLength(1);
    expect((await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe('PAID');
  });

  it('tracks partial payment and outstanding balance', async () => {
    const customer = await createCustomer();
    const invoice = await createAndPostInvoice(customer.id, 100);
    const payment = await createPayment(context(maker), {
      direction: 'INBOUND', customerId: customer.id, treasuryAccountId, currencyCode: 'TZS', amount: 35,
      paymentDate: dateOnly, methods: [{ method: 'MOBILE_MONEY', amount: 35 }],
    });
    await submitPayment(context(maker), payment.id);
    await decidePayment(context(ceo), payment.id, 'APPROVED');
    const completed = await completePayment(context(secondFinance), payment.id);
    expect(completed.status).toBe('COMPLETED');
    const allocations = await db.paymentAllocation.findMany({ where: { paymentId: payment.id } });
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.amount.toString()).toBe('35');
    expect((await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe('PARTIALLY_PAID');
  });

  it('posts supplier payables and outbound payments using multiple methods', async () => {
    const supplier = await createSupplier();
    const invoice = await createInvoice(context(maker), {
      direction: 'PAYABLE', supplierId: supplier.id, invoiceDate: dateOnly, dueDate, currencyCode: 'TZS',
      lines: [{ description: 'M11 supplier service', quantity: 1, unitPrice: 90, accountId: expenseAccountId }],
    });
    await submitInvoice(context(maker), invoice!.id);
    await decideInvoice(context(ceo), invoice!.id, 'APPROVED');
    const sentInvoice = await sendInvoice(context(secondFinance), invoice!.id);
    expect(sentInvoice.status).toBe('SENT');
    await expectBalancedEntry(sentInvoice.journalEntryId!);

    const payment = await createPayment(context(maker), {
      direction: 'OUTBOUND', supplierId: supplier.id, treasuryAccountId, currencyCode: 'TZS', amount: 45,
      paymentDate: dateOnly, methods: [{ method: 'BANK_TRANSFER', amount: 30 }, { method: 'CASH', amount: 15 }],
    });
    await submitPayment(context(maker), payment.id);
    await decidePayment(context(ceo), payment.id, 'APPROVED');
    const completed = await completePayment(context(secondFinance), payment.id);
    expect(completed.receipt).toBeNull();
    await expectBalancedEntry(completed.journalEntryId!);
    expect((await db.invoice.findUniqueOrThrow({ where: { id: invoice!.id } })).status).toBe('PARTIALLY_PAID');
  });

  it('allocates one payment across multiple invoices', async () => {
    const customer = await createCustomer();
    const first = await createAndPostInvoice(customer.id, 60);
    const second = await createAndPostInvoice(customer.id, 70);
    const payment = await createPayment(context(maker), {
      direction: 'INBOUND', customerId: customer.id, treasuryAccountId, currencyCode: 'TZS', amount: 80,
      paymentDate: dateOnly, allocationMode: 'MANUAL',
      methods: [{ method: 'BANK_TRANSFER', amount: 80 }],
      allocations: [{ invoiceId: first.id, amount: 50 }, { invoiceId: second.id, amount: 30 }],
    });
    await submitPayment(context(maker), payment.id);
    await decidePayment(context(ceo), payment.id, 'APPROVED');
    await completePayment(context(secondFinance), payment.id);
    const rows = await db.paymentAllocation.findMany({ where: { paymentId: payment.id }, orderBy: { amount: 'desc' } });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.amount.toString())).toEqual(['50', '30']);
    expect((await db.invoice.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('PARTIALLY_PAID');
    expect((await db.invoice.findUniqueOrThrow({ where: { id: second.id } })).status).toBe('PARTIALLY_PAID');
  });

  it('posts an approved credit note as a debit to revenue and credit to receivables', async () => {
    const customer = await createCustomer();
    const invoice = await createAndPostInvoice(customer.id, 100);
    const note = await createCreditNote(context(maker), {
      invoiceId: invoice.id, reasonCode: 'PRICING_ADJUSTMENT', reason: 'Agreed service price adjustment', amount: 25,
    });
    await submitCreditNote(context(maker), note.id);
    const applied = await decideCreditNote(context(ceo), note.id, 'APPROVED');
    expect(applied.status).toBe('APPLIED');
    const entry = await db.journalEntry.findUniqueOrThrow({ where: { id: applied.journalEntryId! }, include: { lines: true } });
    const revenue = entry.lines.find((line) => line.accountId === revenueAccountId);
    const receivable = entry.lines.find((line) => line.accountId === receivableAccountId);
    expect(revenue?.debit.toString()).toBe('25');
    expect(receivable?.credit.toString()).toBe('25');
    await expectBalancedEntry(entry.id);
  });

  it('rejects a payment allocation to a cancelled invoice', async () => {
    const customer = await createCustomer();
    const invoice = await createAndPostInvoice(customer.id, 100);
    await cancelInvoice(context(secondFinance), invoice.id, 'Customer cancelled the order');
    await expect(createPayment(context(maker), {
      direction: 'INBOUND', customerId: customer.id, treasuryAccountId, currencyCode: 'TZS', amount: 20,
      paymentDate: dateOnly, allocationMode: 'MANUAL', methods: [{ method: 'CASH', amount: 20 }],
      allocations: [{ invoiceId: invoice.id, amount: 20 }],
    })).rejects.toBeInstanceOf(ConflictError);
  });
});

async function createAndPostInvoice(customerId: string, amount: number) {
  const invoice = await createInvoice(context(maker), {
    direction: 'RECEIVABLE', customerId, invoiceDate: dateOnly, dueDate, currencyCode: 'TZS',
    lines: [{ description: 'M11 service', quantity: 1, unitPrice: amount, accountId: revenueAccountId }],
  });
  await submitInvoice(context(maker), invoice!.id);
  await decideInvoice(context(ceo), invoice!.id, 'APPROVED');
  return sendInvoice(context(secondFinance), invoice!.id);
}

async function createCustomer() {
  const party = await db.party.create({
    data: { organizationId, code: `M11-C-${suffix}-${Math.random().toString(36).slice(2, 7)}`, kind: 'COMPANY', displayName: 'M11 Test Customer' },
    select: { id: true },
  });
  return db.customer.create({
    data: { organizationId, partyId: party.id, status: 'ACTIVE', masterDataStatus: 'ACTIVE', creditLimit: 1_000_000, currencyCode: 'TZS', createdById: maker.id },
    select: { id: true },
  });
}

async function createSupplier() {
  const party = await db.party.create({
    data: { organizationId, code: `M11-S-${suffix}-${Math.random().toString(36).slice(2, 7)}`, kind: 'COMPANY', displayName: 'M11 Test Supplier' },
    select: { id: true },
  });
  return db.supplier.create({
    data: { organizationId, partyId: party.id, status: 'ACTIVE', masterDataStatus: 'ACTIVE', createdById: maker.id },
    select: { id: true },
  });
}

async function createActor(label: string, roleId: string, roleCode: string, isFinalApprover: boolean): Promise<TestActor> {
  const email = `m11-${label}-${suffix}@bleca.test`;
  const user = await db.user.create({
    data: {
      id: `m11-${label}-${suffix}`, email, emailNormalized: email, fullName: `M11 ${label}`,
      status: 'ACTIVE', isActive: true,
      organizationMemberships: { create: { organizationId, isDefault: true } },
      userRoles: { create: { roleId, reason: `M11 integration ${roleCode}` } },
    }, select: { id: true, email: true, fullName: true },
  });
  return { ...user, roleCode, isFinalApprover };
}

function context(actor: TestActor): RequestContext {
  return {
    actor: {
      userId: actor.id, email: actor.email, fullName: actor.fullName, roleCodes: [actor.roleCode],
      isFinalApprover: actor.isFinalApprover, organizationId, sessionId: null,
      mfaSatisfiedAt: null, stepUpSatisfiedAt: null, stepUpExpiresAt: null,
    },
    requestId: `m11-${Math.random().toString(36).slice(2, 10)}`, channel: 'API',
    idempotencyKey: null, ipAddress: null, userAgent: 'm11-integration', syncBatchId: null,
  };
}

async function expectBalancedEntry(entryId: string) {
  const lines = await db.journalLine.findMany({ where: { entryId }, select: { debit: true, credit: true } });
  const debits = lines.reduce((sum, line) => sum.plus(line.debit), new Prisma.Decimal(0));
  const credits = lines.reduce((sum, line) => sum.plus(line.credit), new Prisma.Decimal(0));
  expect(debits.toString()).toBe(credits.toString());
  expect(debits.greaterThan(0)).toBe(true);
}
