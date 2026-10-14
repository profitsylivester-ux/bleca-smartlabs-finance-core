import { Prisma } from '@/generated/prisma/client';
import type { PaymentAllocationMode, PaymentDirection, PaymentMethod, PaymentStatus } from '@/generated/prisma/client';
import { advanceRequest, createApprovalRequest } from '@/lib/approvals/engine';
import { authorize } from '@/lib/kernel/authorize';
import type { RequestContext } from '@/lib/kernel/context';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/kernel/errors';
import { assertSupplierPaymentAllowed } from '@/lib/parties/security';
import { prisma } from '@/lib/db/prisma';
import type { Tx } from '@/lib/db/prisma';
import {
  auditSalesChange,
  createAndPostJournalEntry,
  decimal,
  findControlAccount,
  invoiceOutstanding,
  nextDocumentNumber,
  organizationIdOf,
  reversePostedJournalEntry,
  syncInvoiceStatusAndReceivable,
  withSalesAudit,
} from './common';

export interface PaymentAllocationInput {
  invoiceId: string;
  amount: string | number;
}

export interface PaymentMethodInput {
  method: PaymentMethod;
  amount: string | number;
  reference?: string;
}

export interface CreatePaymentInput {
  direction: PaymentDirection;
  customerId?: string;
  supplierId?: string;
  treasuryAccountId: string;
  currencyCode: string;
  amount: string | number;
  paymentDate: string | Date;
  allocationMode?: PaymentAllocationMode;
  onAccountAccountId?: string;
  reference?: string;
  description?: string;
  methods: PaymentMethodInput[];
  allocations?: PaymentAllocationInput[];
}

function asDate(value: string | Date, field: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new ValidationError(`${field} must be a valid date.`);
  return date;
}

async function lockInvoices(tx: Tx, invoiceIds: string[]) {
  const ids = [...new Set(invoiceIds)];
  if (ids.length === 0) return;
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM invoices WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE
  `);
}

async function validateAllocation(
  tx: Tx,
  input: {
    organizationId: string;
    direction: PaymentDirection;
    customerId: string | null;
    supplierId: string | null;
    currencyCode: string;
    invoiceId: string;
    amount: Prisma.Decimal;
  },
) {
  const invoice = await tx.invoice.findFirst({
    where: { id: input.invoiceId, organizationId: input.organizationId },
    select: {
      id: true, direction: true, status: true, customerId: true, supplierId: true,
      currencyCode: true, totalAmount: true, number: true,
    },
  });
  if (!invoice) throw new NotFoundError('Invoice', input.invoiceId);
  const expectedDirection = input.direction === 'INBOUND' ? 'RECEIVABLE' : 'PAYABLE';
  if (invoice.direction !== expectedDirection) throw new ValidationError('Payment direction does not match the invoice direction.');
  if (invoice.status === 'CANCELLED' || invoice.status === 'DRAFT' || invoice.status === 'SUBMITTED' || invoice.status === 'APPROVED' || invoice.status === 'REJECTED') {
    throw new ConflictError(`Invoice ${invoice.number} is not available for payment allocation.`);
  }
  if (invoice.currencyCode !== input.currencyCode) throw new ValidationError('Payment and invoice currencies must match.');
  if (input.direction === 'INBOUND' && invoice.customerId !== input.customerId) {
    throw new ValidationError('An inbound payment can only be allocated to invoices for its customer.');
  }
  if (input.direction === 'OUTBOUND' && invoice.supplierId !== input.supplierId) {
    throw new ValidationError('An outbound payment can only be allocated to invoices for its supplier.');
  }
  if (!input.amount.greaterThan(0)) throw new ValidationError('Allocation amounts must be greater than zero.');
  const balance = await invoiceOutstanding(tx, invoice.id, invoice.totalAmount);
  if (input.amount.greaterThan(balance.outstanding)) {
    throw new ConflictError(`Allocation exceeds the outstanding balance on invoice ${invoice.number}.`, {
      invoiceId: invoice.id, outstanding: balance.outstanding.toString(), requested: input.amount.toString(),
    });
  }
  return { invoice, balance };
}

async function replaceManualAllocations(
  tx: Tx,
  payment: {
    id: string; organizationId: string; direction: PaymentDirection; customerId: string | null;
    supplierId: string | null; currencyCode: string; amount: Prisma.Decimal;
  },
  allocations: PaymentAllocationInput[],
) {
  if (allocations.length === 0) throw new ValidationError('Manual allocation needs at least one invoice.');
  const requested = allocations.map((line) => ({ invoiceId: line.invoiceId, amount: decimal(line.amount) }));
  if (new Set(requested.map((line) => line.invoiceId)).size !== requested.length) {
    throw new ValidationError('A payment may contain only one allocation per invoice.');
  }
  await lockInvoices(tx, requested.map((line) => line.invoiceId));
  let total = new Prisma.Decimal(0);
  for (const line of requested) {
    await validateAllocation(tx, {
      organizationId: payment.organizationId,
      direction: payment.direction,
      customerId: payment.customerId,
      supplierId: payment.supplierId,
      currencyCode: payment.currencyCode,
      invoiceId: line.invoiceId,
      amount: line.amount,
    });
    total = total.plus(line.amount);
  }
  if (total.greaterThan(payment.amount)) throw new ConflictError('Payment allocations exceed the payment amount.');
  await tx.paymentAllocation.deleteMany({ where: { paymentId: payment.id } });
  await tx.paymentAllocation.createMany({
    data: requested.map((line) => ({ paymentId: payment.id, invoiceId: line.invoiceId, amount: line.amount })),
  });
  await tx.payment.update({ where: { id: payment.id }, data: { unappliedAmount: payment.amount.minus(total) } });
  return { allocatedAmount: total, unappliedAmount: payment.amount.minus(total) };
}

export async function createPayment(ctx: RequestContext, input: CreatePaymentInput) {
  await authorize(ctx, { module: 'PAYMENTS', action: 'CONFIGURE' });
  const organizationId = organizationIdOf(ctx);
  const amount = decimal(input.amount);
  const paymentDate = asDate(input.paymentDate, 'paymentDate');
  const allocationMode = input.allocationMode ?? 'FIFO';
  if (!amount.greaterThan(0)) throw new ValidationError('Payment amount must be greater than zero.');
  if (input.direction === 'INBOUND' && (!input.customerId || input.supplierId)) {
    throw new ValidationError('An inbound payment must have exactly one customer.');
  }
  if (input.direction === 'OUTBOUND' && (!input.supplierId || input.customerId)) {
    throw new ValidationError('An outbound payment must have exactly one supplier.');
  }
  if (input.methods.length === 0) throw new ValidationError('At least one payment method is required.');
  const methods = input.methods.map((method) => ({ ...method, amount: decimal(method.amount) }));
  const methodTotal = methods.reduce((sum, method) => sum.plus(method.amount), new Prisma.Decimal(0));
  if (!methodTotal.equals(amount)) throw new ValidationError('Payment method amounts must add up to the total payment amount.');
  if (allocationMode !== 'MANUAL' && input.allocations?.length) {
    throw new ValidationError('Invoice allocations can be supplied only for a manual allocation.');
  }

  return withSalesAudit(ctx, async (tx) => {
    const treasuryAccount = await tx.treasuryAccount.findFirst({
      where: { id: input.treasuryAccountId, organizationId, isActive: true },
      select: { id: true, currencyCode: true },
    });
    if (!treasuryAccount) throw new NotFoundError('Active treasury account', input.treasuryAccountId);
    if (treasuryAccount.currencyCode !== input.currencyCode) throw new ValidationError('Payment currency must match the treasury account currency.');
    if (input.direction === 'OUTBOUND' && input.supplierId) {
      await assertSupplierPaymentAllowed(tx, organizationId, input.supplierId);
    }
    if (input.direction === 'INBOUND' && input.customerId) {
      const customer = await tx.customer.findFirst({
        where: { id: input.customerId, organizationId, deletedAt: null },
        select: { id: true, status: true, masterDataStatus: true },
      });
      if (!customer) throw new NotFoundError('Customer', input.customerId);
      if (customer.status !== 'ACTIVE' || customer.masterDataStatus !== 'ACTIVE') throw new ConflictError('Payments require an active, approved customer.');
    }

    const number = await nextDocumentNumber(tx, organizationId, 'PAYMENT');
    const payment = await tx.payment.create({
      data: {
        organizationId,
        direction: input.direction,
        customerId: input.customerId,
        supplierId: input.supplierId,
        number,
        treasuryAccountId: treasuryAccount.id,
        currencyCode: input.currencyCode,
        amount,
        allocationMode,
        onAccountAccountId: input.onAccountAccountId,
        paymentDate,
        reference: input.reference?.trim() || null,
        description: input.description?.trim() || null,
        createdById: ctx.actor.userId,
        methods: { create: methods.map((method) => ({ method: method.method, amount: method.amount, reference: method.reference?.trim() || null })) },
      },
      include: { methods: true, allocations: true },
    });
    if (allocationMode === 'MANUAL' && input.allocations?.length) {
      await replaceManualAllocations(tx, payment, input.allocations);
    }
    await auditSalesChange(tx, ctx, {
      action: 'PAYMENT_CREATED', entityType: 'PAYMENT', entityId: payment.id,
      entityLabel: payment.number, description: `Created ${payment.direction.toLowerCase()} payment ${payment.number}`,
      changes: { status: { from: null, to: 'DRAFT' }, amount: { from: null, to: amount.toString() } },
      metadata: { currencyCode: payment.currencyCode, methods: methods.map((method) => method.method), allocationMode },
    });
    return tx.payment.findUniqueOrThrow({ where: { id: payment.id }, include: { methods: true, allocations: true } });
  });
}

export async function listPayments(ctx: RequestContext, filters: { status?: PaymentStatus; direction?: PaymentDirection } = {}) {
  await authorize(ctx, { module: 'PAYMENTS', action: 'VIEW' });
  return prisma.payment.findMany({
    where: { organizationId: organizationIdOf(ctx), ...(filters.status ? { status: filters.status } : {}), ...(filters.direction ? { direction: filters.direction } : {}) },
    include: {
      customer: { include: { party: { select: { displayName: true } } } },
      supplier: { include: { party: { select: { displayName: true } } } },
      methods: true,
      allocations: { include: { invoice: true } },
      receipt: true,
    },
    orderBy: [{ paymentDate: 'desc' }, { number: 'desc' }],
  });
}

export async function getPayment(ctx: RequestContext, paymentId: string) {
  await authorize(ctx, { module: 'PAYMENTS', action: 'VIEW' });
  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, organizationId: organizationIdOf(ctx) },
    include: {
      customer: { include: { party: true } }, supplier: { include: { party: true } },
      treasuryAccount: true, methods: true, allocations: { include: { invoice: true } }, receipt: true,
    },
  });
  if (!payment) throw new NotFoundError('Payment', paymentId);
  return payment;
}

export async function updatePaymentDraft(ctx: RequestContext, paymentId: string, input: { paymentDate?: string | Date; reference?: string | null; description?: string | null }) {
  await authorize(ctx, { module: 'PAYMENTS', action: 'EDIT' });
  const organizationId = organizationIdOf(ctx);
  return withSalesAudit(ctx, async (tx) => {
    const payment = await tx.payment.findFirst({ where: { id: paymentId, organizationId } });
    if (!payment) throw new NotFoundError('Payment', paymentId);
    if (payment.status !== 'DRAFT') throw new ConflictError('Only draft payments can be edited.');
    const updated = await tx.payment.update({
      where: { id: payment.id },
      data: {
        ...(input.paymentDate ? { paymentDate: asDate(input.paymentDate, 'paymentDate') } : {}),
        ...(input.reference !== undefined ? { reference: input.reference?.trim() || null } : {}),
        ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
      },
    });
    await auditSalesChange(tx, ctx, {
      action: 'PAYMENT_CREATED', entityType: 'PAYMENT', entityId: payment.id,
      entityLabel: payment.number, description: `Updated draft payment ${payment.number}`,
      changes: { paymentDate: { from: payment.paymentDate.toISOString(), to: updated.paymentDate.toISOString() } },
    });
    return updated;
  });
}

export async function cancelDraftPayment(ctx: RequestContext, paymentId: string, reason: string) {
  await authorize(ctx, { module: 'PAYMENTS', action: 'EDIT' });
  const organizationId = organizationIdOf(ctx);
  if (reason.trim().length < 5) throw new ValidationError('A cancellation reason of at least five characters is required.');
  return withSalesAudit(ctx, async (tx) => {
    const payment = await tx.payment.findFirst({ where: { id: paymentId, organizationId } });
    if (!payment) throw new NotFoundError('Payment', paymentId);
    if (payment.status !== 'DRAFT') throw new ConflictError('Only draft payments can be removed through this endpoint.');
    const updated = await tx.payment.update({ where: { id: payment.id }, data: { status: 'CANCELLED' } });
    await auditSalesChange(tx, ctx, {
      action: 'CONFIGURATION_CHANGES', entityType: 'PAYMENT', entityId: payment.id,
      entityLabel: payment.number, description: `Cancelled draft payment ${payment.number}`,
      changes: { status: { from: 'DRAFT', to: 'CANCELLED' } }, metadata: { reason: reason.trim() },
    });
    return updated;
  });
}

export async function setPaymentAllocations(ctx: RequestContext, paymentId: string, allocations: PaymentAllocationInput[]) {
  await authorize(ctx, { module: 'PAYMENTS', action: 'EDIT' });
  const organizationId = organizationIdOf(ctx);
  return withSalesAudit(ctx, async (tx) => {
    const payment = await tx.payment.findFirst({ where: { id: paymentId, organizationId } });
    if (!payment) throw new NotFoundError('Payment', paymentId);
    if (payment.status !== 'DRAFT' || payment.allocationMode !== 'MANUAL') {
      throw new ConflictError('Only a draft payment using manual allocation can be edited.');
    }
    const totals = await replaceManualAllocations(tx, payment, allocations);
    await auditSalesChange(tx, ctx, {
      action: 'PAYMENT_ALLOCATED', entityType: 'PAYMENT', entityId: payment.id,
      entityLabel: payment.number, description: `Updated invoice allocations for payment ${payment.number}`,
      metadata: { allocations: allocations.map((allocation) => ({ invoiceId: allocation.invoiceId, amount: allocation.amount })), allocatedAmount: totals.allocatedAmount.toString(), unappliedAmount: totals.unappliedAmount.toString() },
    });
    return tx.payment.findUniqueOrThrow({ where: { id: payment.id }, include: { allocations: { include: { invoice: true } } } });
  });
}

export async function submitPayment(ctx: RequestContext, paymentId: string) {
  await authorize(ctx, { module: 'PAYMENTS', action: 'SUBMIT' });
  const organizationId = organizationIdOf(ctx);
  return withSalesAudit(ctx, async (tx) => {
    const payment = await tx.payment.findFirst({ where: { id: paymentId, organizationId }, include: { allocations: true } });
    if (!payment) throw new NotFoundError('Payment', paymentId);
    if (payment.status !== 'DRAFT') throw new ConflictError(`Cannot submit a payment in ${payment.status} status.`);
    if (payment.allocationMode === 'MANUAL' && payment.allocations.length === 0) {
      throw new ValidationError('Manual allocation requires at least one invoice allocation before submission.');
    }
    const request = await createApprovalRequest({
      organizationId,
      entityType: 'PAYMENT',
      entityId: payment.id,
      amount: Number(payment.amount),
      currencyCode: payment.currencyCode,
      submittedById: ctx.actor.userId,
      context: {
        organizationId,
        entityType: 'PAYMENT',
        entityId: payment.id,
        submittedById: ctx.actor.userId,
        amount: Number(payment.amount),
        currencyCode: payment.currencyCode,
        transactionDate: payment.paymentDate,
        counterpartyId: payment.customerId ?? payment.supplierId,
      },
    }, tx);
    const updated = await tx.payment.update({ where: { id: payment.id }, data: { status: 'SUBMITTED', submittedById: ctx.actor.userId, submittedAt: new Date() } });
    await auditSalesChange(tx, ctx, {
      action: 'PAYMENT_SUBMITTED', entityType: 'PAYMENT', entityId: payment.id,
      entityLabel: payment.number, description: `Submitted payment ${payment.number} for approval`,
      changes: { status: { from: 'DRAFT', to: 'SUBMITTED' } }, metadata: { approvalRequestId: request.id },
    });
    return updated;
  });
}

export async function decidePayment(ctx: RequestContext, paymentId: string, decision: 'APPROVED' | 'REJECTED', reason?: string) {
  await authorize(ctx, { module: 'PAYMENTS', action: decision === 'APPROVED' ? 'APPROVE' : 'REJECT' });
  const organizationId = organizationIdOf(ctx);
  return withSalesAudit(ctx, async (tx) => {
    const payment = await tx.payment.findFirst({ where: { id: paymentId, organizationId } });
    if (!payment) throw new NotFoundError('Payment', paymentId);
    if (payment.status !== 'SUBMITTED') throw new ConflictError(`Cannot decide a payment in ${payment.status} status.`);
    if (payment.submittedById === ctx.actor.userId) throw new ConflictError('A payment submitter cannot approve their own payment.');
    const request = await tx.approvalRequest.findFirst({
      where: { organizationId, entityType: 'PAYMENT', entityId: payment.id, status: { in: ['PENDING', 'IN_PROGRESS'] } },
      orderBy: { createdAt: 'desc' }, select: { id: true },
    });
    if (!request) throw new ConflictError('The payment has no pending approval request.');
    await advanceRequest(request.id, decision, {
      userId: ctx.actor.userId, fullName: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes,
    }, { reason, tx });
    const updated = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
    if (decision === 'APPROVED') {
      await auditSalesChange(tx, ctx, {
        action: 'PAYMENT_APPROVED', entityType: 'PAYMENT', entityId: payment.id,
        entityLabel: payment.number, description: `Approved payment ${payment.number}`,
        changes: { status: { from: 'SUBMITTED', to: updated.status } },
      });
    }
    return updated;
  });
}

async function autoAllocate(tx: Tx, payment: {
  id: string; organizationId: string; direction: PaymentDirection; customerId: string | null;
  supplierId: string | null; currencyCode: string; amount: Prisma.Decimal; allocationMode: PaymentAllocationMode;
}) {
  const invoices = await tx.invoice.findMany({
    where: {
      organizationId: payment.organizationId,
      direction: payment.direction === 'INBOUND' ? 'RECEIVABLE' : 'PAYABLE',
      status: { in: ['SENT', 'PARTIALLY_PAID', 'OVERDUE'] },
      currencyCode: payment.currencyCode,
      ...(payment.direction === 'INBOUND' ? { customerId: payment.customerId } : { supplierId: payment.supplierId }),
    },
    select: { id: true, totalAmount: true },
    orderBy: payment.allocationMode === 'FIFO'
      ? [{ invoiceDate: 'asc' }, { dueDate: 'asc' }, { number: 'asc' }]
      : [{ dueDate: 'asc' }, { invoiceDate: 'asc' }, { number: 'asc' }],
  });
  await lockInvoices(tx, invoices.map((invoice) => invoice.id));
  await tx.paymentAllocation.deleteMany({ where: { paymentId: payment.id } });
  let remaining = payment.amount;
  const newAllocations: Array<{ paymentId: string; invoiceId: string; amount: Prisma.Decimal }> = [];
  for (const invoice of invoices) {
    if (!remaining.greaterThan(0)) break;
    const balance = await invoiceOutstanding(tx, invoice.id, invoice.totalAmount);
    if (!balance.outstanding.greaterThan(0)) continue;
    const amount = Prisma.Decimal.min(remaining, balance.outstanding);
    await validateAllocation(tx, {
      organizationId: payment.organizationId,
      direction: payment.direction,
      customerId: payment.customerId,
      supplierId: payment.supplierId,
      currencyCode: payment.currencyCode,
      invoiceId: invoice.id,
      amount,
    });
    newAllocations.push({ paymentId: payment.id, invoiceId: invoice.id, amount });
    remaining = remaining.minus(amount);
  }
  if (newAllocations.length) await tx.paymentAllocation.createMany({ data: newAllocations });
  await tx.payment.update({ where: { id: payment.id }, data: { unappliedAmount: remaining } });
  return { allocations: newAllocations, unappliedAmount: remaining };
}

export async function completePayment(ctx: RequestContext, paymentId: string) {
  await authorize(ctx, { module: 'PAYMENTS', action: 'POST' });
  const organizationId = organizationIdOf(ctx);
  return withSalesAudit(ctx, async (tx) => {
    const payment = await tx.payment.findFirst({
      where: { id: paymentId, organizationId },
      include: { allocations: true, treasuryAccount: true },
    });
    if (!payment) throw new NotFoundError('Payment', paymentId);
    if (payment.status !== 'APPROVED') throw new ConflictError('Only an approved payment can be completed.');
    if (payment.createdById === ctx.actor.userId) throw new ConflictError('The payment creator cannot post their own payment.');
    if (payment.direction === 'OUTBOUND' && payment.supplierId) {
      await assertSupplierPaymentAllowed(tx, organizationId, payment.supplierId);
    }
    if (payment.treasuryAccount.currencyCode !== payment.currencyCode || !payment.treasuryAccount.isActive) {
      throw new ValidationError('The payment treasury account is inactive or has a different currency.');
    }

    if (payment.allocationMode === 'MANUAL') {
      if (payment.allocations.length === 0) throw new ValidationError('Manual allocation requires invoice allocations before payment completion.');
      await lockInvoices(tx, payment.allocations.map((allocation) => allocation.invoiceId));
      for (const allocation of payment.allocations) {
        await validateAllocation(tx, {
          organizationId,
          direction: payment.direction,
          customerId: payment.customerId,
          supplierId: payment.supplierId,
          currencyCode: payment.currencyCode,
          invoiceId: allocation.invoiceId,
          amount: allocation.amount,
        });
      }
    } else {
      await autoAllocate(tx, payment);
    }
    const allocations = await tx.paymentAllocation.findMany({
      where: { paymentId: payment.id },
      include: { invoice: { select: { id: true, number: true, totalAmount: true } } },
    });
    const allocatedAmount = allocations.reduce((sum, allocation) => sum.plus(allocation.amount), new Prisma.Decimal(0));
    if (allocatedAmount.greaterThan(payment.amount)) throw new ConflictError('Payment allocations exceed the payment amount.');
    const unappliedAmount = payment.amount.minus(allocatedAmount);
    let onAccountAccountId = payment.onAccountAccountId;
    if (unappliedAmount.greaterThan(0)) {
      if (!onAccountAccountId) throw new ValidationError('An on-account control account is required for unapplied payment credit.');
      const account = await tx.account.findFirst({
        where: {
          id: onAccountAccountId, organizationId, isPostable: true, status: 'ACTIVE',
          type: payment.direction === 'INBOUND' ? 'LIABILITY' : 'ASSET',
        },
        select: { id: true },
      });
      if (!account) throw new ValidationError('The on-account control account is not an active posting account of the required type.');
    }

    const control = await findControlAccount(tx, organizationId, payment.direction === 'INBOUND' ? 'RECEIVABLE' : 'PAYABLE');
    const treasuryAccountId = payment.treasuryAccount.ledgerAccountId;
    const zero = new Prisma.Decimal(0);
    const lines = payment.direction === 'INBOUND'
      ? [
          { accountId: treasuryAccountId, debit: payment.amount, credit: zero, description: `Payment received ${payment.number}` },
          ...(allocatedAmount.greaterThan(0) ? [{ accountId: control.id, debit: zero, credit: allocatedAmount, description: `Applied to customer invoices (${payment.number})` }] : []),
          ...(unappliedAmount.greaterThan(0) ? [{ accountId: onAccountAccountId!, debit: zero, credit: unappliedAmount, description: `Customer on-account credit ${payment.number}` }] : []),
        ]
      : [
          ...(allocatedAmount.greaterThan(0) ? [{ accountId: control.id, debit: allocatedAmount, credit: zero, description: `Settled supplier invoices (${payment.number})` }] : []),
          ...(unappliedAmount.greaterThan(0) ? [{ accountId: onAccountAccountId!, debit: unappliedAmount, credit: zero, description: `Supplier prepayment ${payment.number}` }] : []),
          { accountId: treasuryAccountId, debit: zero, credit: payment.amount, description: `Payment sent ${payment.number}` },
        ];
    const journalEntryId = await createAndPostJournalEntry(tx, ctx, {
      organizationId,
      date: payment.paymentDate,
      currencyCode: payment.currencyCode,
      source: 'PAYMENT',
      reference: payment.number,
      description: `${payment.direction === 'INBOUND' ? 'Inbound' : 'Outbound'} payment ${payment.number}`,
      submittedById: payment.createdById,
      lines,
    });
    const updated = await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'COMPLETED', journalEntryId, unappliedAmount, completedAt: new Date() },
      include: { allocations: true, methods: true },
    });

    let receipt = null;
    if (payment.direction === 'INBOUND') {
      const number = await nextDocumentNumber(tx, organizationId, 'RECEIPT');
      receipt = await tx.receipt.create({
        data: {
          organizationId,
          paymentId: payment.id,
          number,
          createdById: ctx.actor.userId,
          lines: { create: allocations.map((allocation) => ({ invoiceId: allocation.invoiceId, amount: allocation.amount })) },
        },
        include: { lines: true },
      });
      await auditSalesChange(tx, ctx, {
        action: 'RECEIPT_ISSUED', entityType: 'RECEIPT', entityId: receipt.id,
        entityLabel: receipt.number, description: `Issued receipt ${receipt.number} for payment ${payment.number}`,
        changes: { status: { from: null, to: 'ISSUED' } }, metadata: { paymentId: payment.id },
      });
    }
    for (const allocation of allocations) await syncInvoiceStatusAndReceivable(tx, allocation.invoiceId, organizationId);
    await auditSalesChange(tx, ctx, {
      action: 'PAYMENT_COMPLETED', entityType: 'PAYMENT', entityId: payment.id,
      entityLabel: payment.number, description: `Completed payment ${payment.number}`,
      changes: { status: { from: 'APPROVED', to: 'COMPLETED' }, journalEntryId: { from: null, to: journalEntryId } },
      metadata: { allocatedAmount: allocatedAmount.toString(), unappliedAmount: unappliedAmount.toString(), receiptId: receipt?.id ?? null },
    });
    return { ...updated, receipt };
  });
}

export async function reversePayment(ctx: RequestContext, paymentId: string, reason: string) {
  await authorize(ctx, { module: 'PAYMENTS', action: 'REVERSE' });
  const organizationId = organizationIdOf(ctx);
  if (reason.trim().length < 5) throw new ValidationError('A reversal reason of at least five characters is required.');
  return withSalesAudit(ctx, async (tx) => {
    const payment = await tx.payment.findFirst({ where: { id: paymentId, organizationId } });
    if (!payment) throw new NotFoundError('Payment', paymentId);
    if (payment.status !== 'COMPLETED' || !payment.journalEntryId) throw new ConflictError('Only a completed payment can be reversed.');
    if (payment.createdById === ctx.actor.userId) throw new ConflictError('The payment creator cannot reverse their own payment.');
    const reversalJournalEntryId = await reversePostedJournalEntry(
      tx, ctx, organizationId, payment.journalEntryId, new Date(), payment.number, reason.trim(),
    );
    const updated = await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'REVERSED', reversalJournalEntryId },
      include: { allocations: true, receipt: true },
    });
    if (updated.receipt?.status === 'ISSUED') {
      await tx.receipt.update({
        where: { id: updated.receipt.id },
        data: { status: 'VOIDED', voidedAt: new Date(), voidReason: `Underlying payment reversed: ${reason.trim()}` },
      });
      await auditSalesChange(tx, ctx, {
        action: 'RECEIPT_VOIDED', entityType: 'RECEIPT', entityId: updated.receipt.id,
        entityLabel: updated.receipt.number, description: `Voided receipt ${updated.receipt.number} after payment reversal`,
        changes: { status: { from: 'ISSUED', to: 'VOIDED' } }, metadata: { paymentId: payment.id, reason: reason.trim() },
      });
    }
    const allocations = await tx.paymentAllocation.findMany({ where: { paymentId: payment.id }, select: { invoiceId: true } });
    for (const allocation of allocations) await syncInvoiceStatusAndReceivable(tx, allocation.invoiceId, organizationId);
    await auditSalesChange(tx, ctx, {
      action: 'PAYMENT_REVERSED', entityType: 'PAYMENT', entityId: payment.id,
      entityLabel: payment.number, description: `Reversed payment ${payment.number}`,
      changes: { status: { from: 'COMPLETED', to: 'REVERSED' } },
      metadata: { reason: reason.trim(), reversalJournalEntryId },
    });
    return updated;
  });
}

export async function issueReceipt(ctx: RequestContext, paymentId: string, supportingDocumentId?: string) {
  await authorize(ctx, { module: 'RECEIPTS', action: 'CONFIGURE' });
  const organizationId = organizationIdOf(ctx);
  return withSalesAudit(ctx, async (tx) => {
    const payment = await tx.payment.findFirst({
      where: { id: paymentId, organizationId, direction: 'INBOUND', status: 'COMPLETED' },
      include: { allocations: true, receipt: true },
    });
    if (!payment) throw new NotFoundError('Completed inbound payment', paymentId);
    if (payment.receipt) throw new ConflictError('A receipt has already been issued for this payment.');
    const number = await nextDocumentNumber(tx, organizationId, 'RECEIPT');
    const receipt = await tx.receipt.create({
      data: {
        organizationId, paymentId: payment.id, number, createdById: ctx.actor.userId,
        supportingDocumentId,
        lines: { create: payment.allocations.map((allocation) => ({ invoiceId: allocation.invoiceId, amount: allocation.amount })) },
      },
      include: { lines: true },
    });
    await auditSalesChange(tx, ctx, {
      action: 'RECEIPT_ISSUED', entityType: 'RECEIPT', entityId: receipt.id,
      entityLabel: receipt.number, description: `Issued receipt ${receipt.number}`,
      changes: { status: { from: null, to: 'ISSUED' } }, metadata: { paymentId: payment.id },
    });
    return receipt;
  });
}

export async function listReceipts(ctx: RequestContext) {
  await authorize(ctx, { module: 'RECEIPTS', action: 'VIEW' });
  return prisma.receipt.findMany({
    where: { organizationId: organizationIdOf(ctx) },
    include: { payment: { include: { customer: { include: { party: true } }, methods: true } }, lines: { include: { invoice: true } } },
    orderBy: [{ issuedAt: 'desc' }, { number: 'desc' }],
  });
}

export async function getReceipt(ctx: RequestContext, receiptId: string) {
  await authorize(ctx, { module: 'RECEIPTS', action: 'VIEW' });
  const receipt = await prisma.receipt.findFirst({
    where: { id: receiptId, organizationId: organizationIdOf(ctx) },
    include: { payment: { include: { customer: { include: { party: true } }, methods: true } }, lines: { include: { invoice: true } } },
  });
  if (!receipt) throw new NotFoundError('Receipt', receiptId);
  return receipt;
}

export async function voidReceipt(ctx: RequestContext, receiptId: string, reason: string) {
  await authorize(ctx, { module: 'RECEIPTS', action: 'REVERSE' });
  const organizationId = organizationIdOf(ctx);
  if (reason.trim().length < 5) throw new ValidationError('A receipt void reason of at least five characters is required.');
  return withSalesAudit(ctx, async (tx) => {
    const receipt = await tx.receipt.findFirst({ where: { id: receiptId, organizationId } });
    if (!receipt) throw new NotFoundError('Receipt', receiptId);
    if (receipt.status !== 'ISSUED') throw new ConflictError('Only an issued receipt can be voided.');
    const updated = await tx.receipt.update({ where: { id: receipt.id }, data: { status: 'VOIDED', voidedAt: new Date(), voidReason: reason.trim() } });
    await auditSalesChange(tx, ctx, {
      action: 'RECEIPT_VOIDED', entityType: 'RECEIPT', entityId: receipt.id,
      entityLabel: receipt.number, description: `Voided receipt ${receipt.number}`,
      changes: { status: { from: 'ISSUED', to: 'VOIDED' } }, metadata: { reason: reason.trim() },
    });
    return updated;
  });
}

