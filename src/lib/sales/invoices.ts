import { Prisma, type InvoiceStatus } from '@/generated/prisma/client';
import { advanceRequest, createApprovalRequest } from '@/lib/approvals/engine';
import { authorize } from '@/lib/kernel/authorize';
import type { RequestContext } from '@/lib/kernel/context';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/kernel/errors';
import { evaluateCustomerInvoiceCredit } from '@/lib/parties/security';
import { prisma } from '@/lib/db/prisma';
import type { Tx } from '@/lib/db/prisma';
import {
  assertCurrency,
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

export interface InvoiceLineInput {
  description: string;
  quantity: string | number;
  unitPrice: string | number;
  accountId: string;
  taxRate?: string | number;
  taxAccountId?: string;
  quotationLineId?: string;
}

export interface CreateInvoiceInput {
  direction: 'RECEIVABLE' | 'PAYABLE';
  customerId?: string;
  supplierId?: string;
  quotationId?: string;
  invoiceDate: string | Date;
  dueDate: string | Date;
  currencyCode: string;
  reference?: string;
  notes?: string;
  isTaxInvoice?: boolean;
  taxInvoiceNumber?: string;
  recurrenceFrequency?: 'MONTHLY' | 'QUARTERLY' | 'ANNUALLY';
  recurrenceEndsAt?: string | Date;
  recurrenceTemplateId?: string;
  lines: InvoiceLineInput[];
}

function asDate(value: string | Date, field: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new ValidationError(`${field} must be a valid date.`);
  return date;
}

async function prepareInvoiceLines(
  tx: Tx,
  organizationId: string,
  direction: 'RECEIVABLE' | 'PAYABLE',
  input: InvoiceLineInput[],
) {
  if (input.length === 0) throw new ValidationError('An invoice must contain at least one line.');
  const expectedAccountType = direction === 'RECEIVABLE' ? 'REVENUE' : 'EXPENSE';
  const expectedTaxType = direction === 'RECEIVABLE' ? 'LIABILITY' : 'ASSET';
  const lines = [];
  for (const line of input) {
    const quantity = decimal(line.quantity);
    const unitPrice = decimal(line.unitPrice);
    const taxRate = line.taxRate === undefined ? new Prisma.Decimal(0) : decimal(line.taxRate);
    if (!line.description.trim() || !quantity.greaterThan(0) || unitPrice.lessThan(0) || taxRate.lessThan(0)) {
      throw new ValidationError('Invoice lines need a description, positive quantity, and non-negative amounts.');
    }
    const account = await tx.account.findFirst({
      where: { id: line.accountId, organizationId, isPostable: true, status: 'ACTIVE' },
      select: { id: true, type: true },
    });
    if (!account) throw new NotFoundError('Active posting account', line.accountId);
    if (account.type !== expectedAccountType) {
      throw new ValidationError(`A ${direction.toLowerCase()} invoice line must use an ${expectedAccountType.toLowerCase()} account.`);
    }
    const amount = quantity.times(unitPrice);
    const taxAmount = amount.times(taxRate).dividedBy(100).toDecimalPlaces(6);
    if (taxAmount.greaterThan(0) && !line.taxAccountId) {
      throw new ValidationError('A tax account is required when a line has tax.');
    }
    if (line.taxAccountId) {
      const taxAccount = await tx.account.findFirst({
        where: { id: line.taxAccountId, organizationId, isPostable: true, status: 'ACTIVE' },
        select: { id: true, type: true },
      });
      if (!taxAccount) throw new NotFoundError('Active tax account', line.taxAccountId);
      if (taxAccount.type !== expectedTaxType) {
        throw new ValidationError(`A ${direction.toLowerCase()} tax line must use an ${expectedTaxType.toLowerCase()} account.`);
      }
    }
    lines.push({
      description: line.description.trim(),
      quantity,
      unitPrice,
      amount,
      taxRate: line.taxRate === undefined ? null : taxRate,
      taxAmount,
      taxAccountId: line.taxAccountId ?? null,
      accountId: account.id,
      quotationLineId: line.quotationLineId ?? null,
    });
  }
  return lines;
}

export async function createInvoice(ctx: RequestContext, input: CreateInvoiceInput) {
  await authorize(ctx, { module: 'INVOICES', action: 'CONFIGURE' });
  const organizationId = organizationIdOf(ctx);
  const invoiceDate = asDate(input.invoiceDate, 'invoiceDate');
  const dueDate = asDate(input.dueDate, 'dueDate');
  if (dueDate < invoiceDate) throw new ValidationError('An invoice due date cannot precede its invoice date.');
  if (input.direction === 'RECEIVABLE' && (!input.customerId || input.supplierId)) {
    throw new ValidationError('A receivable invoice must have exactly one customer.');
  }
  if (input.direction === 'PAYABLE' && (!input.supplierId || input.customerId)) {
    throw new ValidationError('A payable invoice must have exactly one supplier.');
  }
  if (input.isTaxInvoice && (!input.taxInvoiceNumber || input.direction !== 'RECEIVABLE')) {
    throw new ValidationError('A tax invoice needs a tax invoice number and must be a receivable invoice.');
  }
  const recurrenceEndsAt = input.recurrenceEndsAt ? asDate(input.recurrenceEndsAt, 'recurrenceEndsAt') : null;

  const outcome = await withSalesAudit(ctx, async (tx) => {
    await assertCurrency(tx, input.currencyCode);
    const lines = await prepareInvoiceLines(tx, organizationId, input.direction, input.lines);
    const subtotal = lines.reduce((sum, line) => sum.plus(line.amount), new Prisma.Decimal(0));
    const taxAmount = lines.reduce((sum, line) => sum.plus(line.taxAmount), new Prisma.Decimal(0));
    const totalAmount = subtotal.plus(taxAmount);

    if (input.direction === 'RECEIVABLE' && input.customerId) {
      const credit = await evaluateCustomerInvoiceCredit(tx, {
        organizationId,
        customerId: input.customerId,
        invoiceAmount: totalAmount,
        actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
      });
      if (!credit.allowed) return { denied: credit.reason ?? 'The customer credit check failed.', invoice: null };
    }
    if (input.direction === 'PAYABLE' && input.supplierId) {
      const supplier = await tx.supplier.findFirst({
        where: { id: input.supplierId, organizationId, deletedAt: null },
        select: { id: true, status: true, masterDataStatus: true },
      });
      if (!supplier) throw new NotFoundError('Supplier', input.supplierId);
      if (supplier.status !== 'ACTIVE' || supplier.masterDataStatus !== 'ACTIVE') {
        throw new ConflictError('Payable invoices require an active, approved supplier.');
      }
    }
    if (input.isTaxInvoice) {
      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { registrationStatus: true },
      });
      if (organization.registrationStatus !== 'REGISTERED') {
        throw new ValidationError('A tax invoice cannot be issued while the organization is not registered.');
      }
    }

    const invoice = await createInvoiceInTransaction(tx, ctx, organizationId, {
      ...input,
      invoiceDate,
      dueDate,
      recurrenceEndsAt,
      lines,
      subtotal,
      taxAmount,
      totalAmount,
    });
    await auditSalesChange(tx, ctx, {
      action: 'INVOICE_CREATED', entityType: 'INVOICE', entityId: invoice.id,
      entityLabel: invoice.number, description: `Created invoice ${invoice.number}`,
      changes: { status: { from: null, to: 'DRAFT' }, totalAmount: { from: null, to: totalAmount.toString() } },
      metadata: { direction: invoice.direction, currencyCode: invoice.currencyCode, lineCount: invoice.lines.length },
    });
    return { denied: null, invoice };
  });
  if (outcome.denied) throw new ConflictError(outcome.denied);
  return outcome.invoice;
}

type PreparedInvoiceInput = Omit<CreateInvoiceInput, 'invoiceDate' | 'dueDate' | 'recurrenceEndsAt' | 'lines'> & {
  invoiceDate: Date;
  dueDate: Date;
  recurrenceEndsAt: Date | null;
  lines: Awaited<ReturnType<typeof prepareInvoiceLines>>;
  subtotal: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
};

async function createInvoiceInTransaction(
  tx: Tx,
  ctx: RequestContext,
  organizationId: string,
  input: PreparedInvoiceInput,
) {
  const number = await nextDocumentNumber(tx, organizationId, 'INVOICE');
  const invoice = await tx.invoice.create({
    data: {
      organizationId,
      direction: input.direction,
      customerId: input.customerId,
      supplierId: input.supplierId,
      quotationId: input.quotationId,
      number,
      invoiceDate: input.invoiceDate,
      dueDate: input.dueDate,
      currencyCode: input.currencyCode,
      reference: input.reference?.trim() || null,
      notes: input.notes?.trim() || null,
      subtotal: input.subtotal,
      taxAmount: input.taxAmount,
      totalAmount: input.totalAmount,
      isTaxInvoice: input.isTaxInvoice ?? false,
      taxInvoiceNumber: input.taxInvoiceNumber?.trim() || null,
      recurrenceFrequency: input.recurrenceFrequency,
      recurrenceNextAt: input.recurrenceFrequency ? nextRecurrenceDate(input.invoiceDate, input.recurrenceFrequency) : null,
      recurrenceEndsAt: input.recurrenceEndsAt,
      recurrenceTemplateId: input.recurrenceTemplateId,
      createdById: ctx.actor.userId,
      lines: { create: input.lines },
    },
    include: { lines: true },
  });
  return invoice;
}

export async function createInvoiceFromQuotation(
  tx: Tx,
  ctx: RequestContext,
  organizationId: string,
  quotation: { id: string; customerId: string; currencyCode: string; lines: Array<{ id: string; description: string; unitPrice: Prisma.Decimal }> },
  input: {
    invoiceDate: string;
    dueDate: string;
    lines: Array<{ quotationLineId: string; quantity: string | number; accountId: string; taxRate?: string | number; taxAccountId?: string }>;
  },
) {
  const quoteLines = new Map(quotation.lines.map((line) => [line.id, line]));
  const convertedLines: InvoiceLineInput[] = input.lines.map((line) => {
    const quotationLine = quoteLines.get(line.quotationLineId);
    if (!quotationLine) throw new ValidationError('The invoice line does not belong to this quotation.');
    return {
      quotationLineId: line.quotationLineId,
      description: quotationLine.description,
      quantity: line.quantity,
      unitPrice: quotationLine.unitPrice.toString(),
      accountId: line.accountId,
      taxRate: line.taxRate,
      taxAccountId: line.taxAccountId,
    };
  });
  const invoiceDate = asDate(input.invoiceDate, 'invoiceDate');
  const dueDate = asDate(input.dueDate, 'dueDate');
  if (dueDate < invoiceDate) throw new ValidationError('An invoice due date cannot precede its invoice date.');
  await assertCurrency(tx, quotation.currencyCode);
  const lines = await prepareInvoiceLines(tx, organizationId, 'RECEIVABLE', convertedLines);
  const subtotal = lines.reduce((sum, line) => sum.plus(line.amount), new Prisma.Decimal(0));
  const taxAmount = lines.reduce((sum, line) => sum.plus(line.taxAmount), new Prisma.Decimal(0));
  return createInvoiceInTransaction(tx, ctx, organizationId, {
    direction: 'RECEIVABLE',
    customerId: quotation.customerId,
    quotationId: quotation.id,
    invoiceDate,
    dueDate,
    currencyCode: quotation.currencyCode,
    lines,
    subtotal,
    taxAmount,
    totalAmount: subtotal.plus(taxAmount),
    recurrenceEndsAt: null,
    isTaxInvoice: false,
  });
}

export async function listInvoices(ctx: RequestContext, filters: { status?: InvoiceStatus; direction?: 'RECEIVABLE' | 'PAYABLE' } = {}) {
  await authorize(ctx, { module: 'INVOICES', action: 'VIEW' });
  return prisma.invoice.findMany({
    where: { organizationId: organizationIdOf(ctx), ...(filters.status ? { status: filters.status } : {}), ...(filters.direction ? { direction: filters.direction } : {}) },
    include: {
      customer: { include: { party: { select: { displayName: true } } } },
      supplier: { include: { party: { select: { displayName: true } } } },
      lines: true,
    },
    orderBy: [{ invoiceDate: 'desc' }, { number: 'desc' }],
  });
}

export async function getInvoice(ctx: RequestContext, invoiceId: string) {
  await authorize(ctx, { module: 'INVOICES', action: 'VIEW' });
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, organizationId: organizationIdOf(ctx) },
    include: {
      customer: { include: { party: true } },
      supplier: { include: { party: true } },
      quotation: true,
      lines: true,
      allocations: { include: { payment: true } },
      creditNotes: true,
      debitNotes: true,
      reminders: { orderBy: { scheduledAt: 'desc' } },
    },
  });
  if (!invoice) throw new NotFoundError('Invoice', invoiceId);
  const balance = await invoiceOutstanding(prisma, invoice.id, invoice.totalAmount);
  return { ...invoice, balance: balance.outstanding.toString(), paidAmount: balance.paid.toString() };
}

export async function submitInvoice(ctx: RequestContext, invoiceId: string) {
  await authorize(ctx, { module: 'INVOICES', action: 'SUBMIT' });
  const organizationId = organizationIdOf(ctx);
  return withSalesAudit(ctx, async (tx) => {
    const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, organizationId } });
    if (!invoice) throw new NotFoundError('Invoice', invoiceId);
    if (invoice.status !== 'DRAFT') throw new ConflictError(`Cannot submit an invoice in ${invoice.status} status.`);
    const request = await createApprovalRequest({
      organizationId,
      entityType: 'INVOICE',
      entityId: invoice.id,
      amount: Number(invoice.totalAmount),
      currencyCode: invoice.currencyCode,
      submittedById: ctx.actor.userId,
      context: {
        organizationId,
        entityType: 'INVOICE',
        entityId: invoice.id,
        submittedById: ctx.actor.userId,
        amount: Number(invoice.totalAmount),
        currencyCode: invoice.currencyCode,
        transactionDate: invoice.invoiceDate,
        counterpartyId: invoice.customerId ?? invoice.supplierId,
      },
    }, tx);
    const updated = await tx.invoice.update({
      where: { id: invoice.id },
      data: { status: 'SUBMITTED', submittedById: ctx.actor.userId, submittedAt: new Date() },
    });
    await auditSalesChange(tx, ctx, {
      action: 'INVOICE_SUBMITTED', entityType: 'INVOICE', entityId: invoice.id,
      entityLabel: invoice.number, description: `Submitted invoice ${invoice.number} for approval`,
      changes: { status: { from: 'DRAFT', to: 'SUBMITTED' } }, metadata: { approvalRequestId: request.id },
    });
    return updated;
  });
}

export async function decideInvoice(ctx: RequestContext, invoiceId: string, decision: 'APPROVED' | 'REJECTED', reason?: string) {
  await authorize(ctx, { module: 'INVOICES', action: decision === 'APPROVED' ? 'APPROVE' : 'REJECT' });
  const organizationId = organizationIdOf(ctx);
  return withSalesAudit(ctx, async (tx) => {
    const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, organizationId } });
    if (!invoice) throw new NotFoundError('Invoice', invoiceId);
    if (invoice.status !== 'SUBMITTED') throw new ConflictError(`Cannot decide an invoice in ${invoice.status} status.`);
    if (invoice.submittedById === ctx.actor.userId) throw new ConflictError('An invoice submitter cannot approve their own invoice.');
    const request = await tx.approvalRequest.findFirst({
      where: { organizationId, entityType: 'INVOICE', entityId: invoice.id, status: { in: ['PENDING', 'IN_PROGRESS'] } },
      orderBy: { createdAt: 'desc' }, select: { id: true },
    });
    if (!request) throw new ConflictError('The invoice has no pending approval request.');
    await advanceRequest(request.id, decision, {
      userId: ctx.actor.userId, fullName: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes,
    }, { reason, tx });
    const updated = await tx.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    if (decision === 'APPROVED') {
      await auditSalesChange(tx, ctx, {
        action: 'INVOICE_APPROVED', entityType: 'INVOICE', entityId: invoice.id,
        entityLabel: invoice.number, description: `Approved invoice ${invoice.number}`,
        changes: { status: { from: 'SUBMITTED', to: updated.status } },
      });
    }
    return updated;
  });
}

export async function sendInvoice(ctx: RequestContext, invoiceId: string) {
  await authorize(ctx, { module: 'INVOICES', action: 'POST' });
  const organizationId = organizationIdOf(ctx);
  return withSalesAudit(ctx, async (tx) => {
    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId, organizationId },
      include: { lines: true },
    });
    if (!invoice) throw new NotFoundError('Invoice', invoiceId);
    if (invoice.status !== 'APPROVED') throw new ConflictError('Only an approved invoice can be sent.');
    if (invoice.journalEntryId) throw new ConflictError('This invoice has already been posted.');
    if (invoice.createdById === ctx.actor.userId) throw new ConflictError('The invoice creator cannot post their own invoice.');

    const control = await findControlAccount(tx, organizationId, invoice.direction === 'RECEIVABLE' ? 'RECEIVABLE' : 'PAYABLE');
    const lines: Array<{ accountId: string; debit: Prisma.Decimal; credit: Prisma.Decimal; description: string }> = [];
    if (invoice.direction === 'RECEIVABLE') {
      lines.push({ accountId: control.id, debit: invoice.totalAmount, credit: new Prisma.Decimal(0), description: `Trade receivable ${invoice.number}` });
      for (const line of invoice.lines) {
        lines.push({ accountId: line.accountId, debit: new Prisma.Decimal(0), credit: line.amount, description: line.description });
        if (line.taxAmount.greaterThan(0) && line.taxAccountId) {
          lines.push({ accountId: line.taxAccountId, debit: new Prisma.Decimal(0), credit: line.taxAmount, description: `Tax on ${line.description}` });
        }
      }
    } else {
      for (const line of invoice.lines) {
        lines.push({ accountId: line.accountId, debit: line.amount, credit: new Prisma.Decimal(0), description: line.description });
        if (line.taxAmount.greaterThan(0) && line.taxAccountId) {
          lines.push({ accountId: line.taxAccountId, debit: line.taxAmount, credit: new Prisma.Decimal(0), description: `Recoverable tax on ${line.description}` });
        }
      }
      lines.push({ accountId: control.id, debit: new Prisma.Decimal(0), credit: invoice.totalAmount, description: `Trade payable ${invoice.number}` });
    }

    const journalEntryId = await createAndPostJournalEntry(tx, ctx, {
      organizationId,
      date: invoice.invoiceDate,
      currencyCode: invoice.currencyCode,
      source: 'INVOICE',
      reference: invoice.number,
      description: `${invoice.direction === 'RECEIVABLE' ? 'Sales' : 'Purchase'} invoice ${invoice.number}`,
      submittedById: invoice.createdById,
      lines,
    });
    const updated = await tx.invoice.update({
      where: { id: invoice.id },
      data: { status: 'SENT', sentAt: new Date(), journalEntryId },
      include: { lines: true },
    });
    await syncInvoiceStatusAndReceivable(tx, invoice.id, organizationId);
    await auditSalesChange(tx, ctx, {
      action: 'INVOICE_SENT', entityType: 'INVOICE', entityId: invoice.id,
      entityLabel: invoice.number, description: `Posted and sent invoice ${invoice.number}`,
      changes: { status: { from: 'APPROVED', to: updated.status }, journalEntryId: { from: null, to: journalEntryId } },
    });
    return updated;
  });
}

export async function cancelInvoice(ctx: RequestContext, invoiceId: string, reason: string) {
  await authorize(ctx, { module: 'INVOICES', action: 'REVERSE' });
  const organizationId = organizationIdOf(ctx);
  if (reason.trim().length < 5) throw new ValidationError('A cancellation reason of at least five characters is required.');
  return withSalesAudit(ctx, async (tx) => {
    const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, organizationId } });
    if (!invoice) throw new NotFoundError('Invoice', invoiceId);
    if (invoice.status === 'CANCELLED' || invoice.status === 'REJECTED') throw new ConflictError(`Cannot cancel an invoice in ${invoice.status} status.`);
    const balance = await invoiceOutstanding(tx, invoice.id, invoice.totalAmount);
    if (!balance.paid.isZero() || !balance.credited.isZero() || !balance.debited.isZero()) {
      throw new ConflictError('An invoice with payments or adjustment notes cannot be cancelled. Apply an adjustment note instead.');
    }
    let reversalJournalEntryId: string | null = null;
    if (invoice.journalEntryId) {
      if (invoice.createdById === ctx.actor.userId) throw new ConflictError('The invoice creator cannot reverse their own invoice.');
      reversalJournalEntryId = await reversePostedJournalEntry(
        tx, ctx, organizationId, invoice.journalEntryId, new Date(), invoice.number, reason.trim(),
      );
    }
    const updated = await tx.invoice.update({
      where: { id: invoice.id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancellationReason: reason.trim(), reversalJournalEntryId },
    });
    await tx.customerReceivable.updateMany({
      where: { organizationId, invoiceId: invoice.id },
      data: { status: 'CANCELLED', outstandingAmount: 0 },
    });
    await auditSalesChange(tx, ctx, {
      action: 'INVOICE_CANCELLED', entityType: 'INVOICE', entityId: invoice.id,
      entityLabel: invoice.number, description: `Cancelled invoice ${invoice.number}`,
      changes: { status: { from: invoice.status, to: 'CANCELLED' } },
      metadata: { reason: reason.trim(), reversalJournalEntryId },
    });
    return updated;
  });
}

export async function updateInvoiceDraft(ctx: RequestContext, invoiceId: string, input: { dueDate?: string | Date; reference?: string | null; notes?: string | null }) {
  await authorize(ctx, { module: 'INVOICES', action: 'EDIT' });
  const organizationId = organizationIdOf(ctx);
  return withSalesAudit(ctx, async (tx) => {
    const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, organizationId } });
    if (!invoice) throw new NotFoundError('Invoice', invoiceId);
    if (invoice.status !== 'DRAFT') throw new ConflictError('Only draft invoices can be edited.');
    const dueDate = input.dueDate ? asDate(input.dueDate, 'dueDate') : invoice.dueDate;
    if (dueDate < invoice.invoiceDate) throw new ValidationError('An invoice due date cannot precede its invoice date.');
    const updated = await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        dueDate,
        ...(input.reference !== undefined ? { reference: input.reference?.trim() || null } : {}),
        ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
      },
    });
    await auditSalesChange(tx, ctx, {
      action: 'INVOICE_CREATED', entityType: 'INVOICE', entityId: invoice.id,
      entityLabel: invoice.number, description: `Updated draft invoice ${invoice.number}`,
      changes: { dueDate: { from: invoice.dueDate.toISOString(), to: updated.dueDate.toISOString() } },
    });
    return updated;
  });
}

export async function cancelDraftInvoice(ctx: RequestContext, invoiceId: string, reason: string) {
  await authorize(ctx, { module: 'INVOICES', action: 'EDIT' });
  const organizationId = organizationIdOf(ctx);
  if (reason.trim().length < 5) throw new ValidationError('A cancellation reason of at least five characters is required.');
  return withSalesAudit(ctx, async (tx) => {
    const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, organizationId } });
    if (!invoice) throw new NotFoundError('Invoice', invoiceId);
    if (invoice.status !== 'DRAFT') throw new ConflictError('Only draft invoices can be removed through this endpoint.');
    const updated = await tx.invoice.update({
      where: { id: invoice.id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancellationReason: reason.trim() },
    });
    await auditSalesChange(tx, ctx, {
      action: 'INVOICE_CANCELLED', entityType: 'INVOICE', entityId: invoice.id,
      entityLabel: invoice.number, description: `Cancelled draft invoice ${invoice.number}`,
      changes: { status: { from: 'DRAFT', to: 'CANCELLED' } }, metadata: { reason: reason.trim() },
    });
    return updated;
  });
}

export async function generateRecurringInvoice(ctx: RequestContext, templateId: string) {
  await authorize(ctx, { module: 'INVOICES', action: 'CONFIGURE' });
  const organizationId = organizationIdOf(ctx);
  const outcome = await withSalesAudit(ctx, async (tx) => {
    const template = await tx.invoice.findFirst({
      where: { id: templateId, organizationId },
      include: { lines: true },
    });
    if (!template) throw new NotFoundError('Invoice', templateId);
    if (!template.recurrenceFrequency || !template.recurrenceNextAt) {
      throw new ConflictError('This invoice is not configured as a recurring invoice.');
    }
    const invoiceDate = template.recurrenceNextAt;
    if (template.recurrenceEndsAt && invoiceDate > template.recurrenceEndsAt) {
      return { denied: 'The recurring invoice end date has passed.', invoice: null };
    }
    const dueOffset = template.dueDate.getTime() - template.invoiceDate.getTime();
    const dueDate = new Date(invoiceDate.getTime() + dueOffset);
    const lines = template.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      amount: line.amount,
      taxRate: line.taxRate,
      taxAmount: line.taxAmount,
      taxAccountId: line.taxAccountId,
      accountId: line.accountId,
      quotationLineId: null,
    }));
    const subtotal = lines.reduce((sum, line) => sum.plus(line.amount), new Prisma.Decimal(0));
    const taxAmount = lines.reduce((sum, line) => sum.plus(line.taxAmount), new Prisma.Decimal(0));
    if (template.direction === 'RECEIVABLE' && template.customerId) {
      const credit = await evaluateCustomerInvoiceCredit(tx, {
        organizationId,
        customerId: template.customerId,
        invoiceAmount: subtotal.plus(taxAmount),
        actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
      });
      if (!credit.allowed) return { denied: credit.reason ?? 'The customer credit check failed.', invoice: null };
    }
    const invoice = await createInvoiceInTransaction(tx, ctx, organizationId, {
      direction: template.direction,
      customerId: template.customerId ?? undefined,
      supplierId: template.supplierId ?? undefined,
      invoiceDate,
      dueDate,
      currencyCode: template.currencyCode,
      lines,
      subtotal,
      taxAmount,
      totalAmount: subtotal.plus(taxAmount),
      recurrenceEndsAt: null,
      recurrenceTemplateId: template.id,
    });
    const next = nextRecurrenceDate(invoiceDate, template.recurrenceFrequency);
    await tx.invoice.update({ where: { id: template.id }, data: { recurrenceNextAt: next } });
    await auditSalesChange(tx, ctx, {
      action: 'INVOICE_CREATED', entityType: 'INVOICE', entityId: invoice.id,
      entityLabel: invoice.number, description: `Generated recurring invoice ${invoice.number}`,
      changes: { status: { from: null, to: 'DRAFT' } }, metadata: { recurrenceTemplateId: template.id },
    });
    return { denied: null, invoice };
  });
  if (outcome.denied) throw new ConflictError(outcome.denied);
  return outcome.invoice;
}

function nextRecurrenceDate(date: Date, frequency: 'MONTHLY' | 'QUARTERLY' | 'ANNUALLY') {
  const next = new Date(date);
  if (frequency === 'MONTHLY') next.setUTCMonth(next.getUTCMonth() + 1);
  if (frequency === 'QUARTERLY') next.setUTCMonth(next.getUTCMonth() + 3);
  if (frequency === 'ANNUALLY') next.setUTCFullYear(next.getUTCFullYear() + 1);
  return next;
}

export async function createInvoiceReminder(ctx: RequestContext, invoiceId: string, message?: string) {
  await authorize(ctx, { module: 'INVOICES', action: 'EDIT' });
  const organizationId = organizationIdOf(ctx);
  return withSalesAudit(ctx, async (tx) => {
    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId, organizationId, direction: 'RECEIVABLE' },
      include: { customer: { include: { party: { select: { email: true, displayName: true } } } } },
    });
    if (!invoice) throw new NotFoundError('Receivable invoice', invoiceId);
    const balance = await invoiceOutstanding(tx, invoice.id, invoice.totalAmount);
    if (balance.outstanding.lte(0) || invoice.status === 'CANCELLED') throw new ConflictError('This invoice has no outstanding balance to remind about.');
    const created = await tx.invoiceReminder.create({
      data: {
        organizationId,
        invoiceId: invoice.id,
        recipient: invoice.customer?.party.email ?? null,
        message: message?.trim() || `Payment reminder for invoice ${invoice.number}: ${balance.outstanding.toString()} ${invoice.currencyCode} remains outstanding.`,
        createdById: ctx.actor.userId,
      },
    });
    await auditSalesChange(tx, ctx, {
      action: 'INVOICE_REMINDER_CREATED', entityType: 'INVOICE', entityId: invoice.id,
      entityLabel: invoice.number, description: `Queued payment reminder for invoice ${invoice.number}`,
      metadata: { reminderId: created.id, recipient: created.recipient, outstandingAmount: balance.outstanding.toString() },
    });
    return created;
  });
}

