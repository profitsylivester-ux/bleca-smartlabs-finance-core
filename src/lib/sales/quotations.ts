import { Prisma, type QuotationStatus } from '@/generated/prisma/client';
import { advanceRequest, createApprovalRequest } from '@/lib/approvals/engine';
import { authorize } from '@/lib/kernel/authorize';
import type { RequestContext } from '@/lib/kernel/context';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/kernel/errors';
import { prisma } from '@/lib/db/prisma';
import { evaluateCustomerInvoiceCredit } from '@/lib/parties/security';
import {
  assertCurrency,
  auditSalesChange,
  nextDocumentNumber,
  organizationIdOf,
  withSalesAudit,
} from './common';
import { createInvoiceFromQuotation } from './invoices';

export interface QuotationLineInput {
  description: string;
  quantity: string | number;
  unitPrice: string | number;
}

export interface CreateQuotationInput {
  customerId: string;
  quoteDate: string | Date;
  validUntil: string | Date;
  currencyCode: string;
  reference?: string;
  notes?: string;
  lines: QuotationLineInput[];
}

function asDate(value: string | Date, field: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new ValidationError(`${field} must be a valid date.`);
  return date;
}

function requireQuotationLines(lines: QuotationLineInput[]) {
  if (lines.length === 0) throw new ValidationError('A quotation must contain at least one line.');
  return lines.map((line) => {
    const quantity = new Prisma.Decimal(line.quantity);
    const unitPrice = new Prisma.Decimal(line.unitPrice);
    if (!quantity.greaterThan(0) || unitPrice.lessThan(0) || !line.description.trim()) {
      throw new ValidationError('Quotation lines need a description, positive quantity, and non-negative unit price.');
    }
    return { description: line.description.trim(), quantity, unitPrice, amount: quantity.times(unitPrice) };
  });
}

export async function createQuotation(ctx: RequestContext, input: CreateQuotationInput) {
  await authorize(ctx, { module: 'QUOTATIONS', action: 'CREATE' });
  const organizationId = organizationIdOf(ctx);
  const quoteDate = asDate(input.quoteDate, 'quoteDate');
  const validUntil = asDate(input.validUntil, 'validUntil');
  if (validUntil < quoteDate) throw new ValidationError('A quotation cannot expire before its quote date.');
  const lines = requireQuotationLines(input.lines);
  const subtotal = lines.reduce((sum, line) => sum.plus(line.amount), new Prisma.Decimal(0));

  return withSalesAudit(ctx, async (tx) => {
    const customer = await tx.customer.findFirst({
      where: { id: input.customerId, organizationId, deletedAt: null },
      select: { id: true, status: true, masterDataStatus: true },
    });
    if (!customer) throw new NotFoundError('Customer', input.customerId);
    if (customer.status !== 'ACTIVE' || customer.masterDataStatus !== 'ACTIVE') {
      throw new ConflictError('Quotations require an active, approved customer.');
    }
    await assertCurrency(tx, input.currencyCode);
    const number = await nextDocumentNumber(tx, organizationId, 'QUOTATION');
    const quotation = await tx.quotation.create({
      data: {
        organizationId,
        customerId: customer.id,
        number,
        quoteDate,
        validUntil,
        currencyCode: input.currencyCode,
        reference: input.reference?.trim() || null,
        notes: input.notes?.trim() || null,
        subtotal,
        taxAmount: new Prisma.Decimal(0),
        totalAmount: subtotal,
        createdById: ctx.actor.userId,
        lines: { create: lines },
      },
      include: { lines: true },
    });
    await auditSalesChange(tx, ctx, {
      action: 'QUOTATION_CREATED',
      entityType: 'QUOTATION',
      entityId: quotation.id,
      entityLabel: quotation.number,
      description: `Created quotation ${quotation.number}`,
      changes: { status: { from: null, to: 'DRAFT' }, totalAmount: { from: null, to: subtotal.toString() } },
      metadata: { customerId: customer.id, currencyCode: quotation.currencyCode, lineCount: quotation.lines.length },
    });
    return quotation;
  });
}

export async function listQuotations(ctx: RequestContext, status?: QuotationStatus) {
  await authorize(ctx, { module: 'QUOTATIONS', action: 'VIEW' });
  return prisma.quotation.findMany({
    where: { organizationId: organizationIdOf(ctx), ...(status ? { status } : {}) },
    include: { customer: { include: { party: { select: { displayName: true, email: true } } } }, lines: true },
    orderBy: [{ quoteDate: 'desc' }, { number: 'desc' }],
  });
}

export async function getQuotation(ctx: RequestContext, quotationId: string) {
  await authorize(ctx, { module: 'QUOTATIONS', action: 'VIEW' });
  const quotation = await prisma.quotation.findFirst({
    where: { id: quotationId, organizationId: organizationIdOf(ctx) },
    include: { customer: { include: { party: true } }, lines: { include: { invoiceLines: true } }, invoices: true },
  });
  if (!quotation) throw new NotFoundError('Quotation', quotationId);
  return quotation;
}

export async function submitQuotation(ctx: RequestContext, quotationId: string) {
  await authorize(ctx, { module: 'QUOTATIONS', action: 'SUBMIT' });
  const organizationId = organizationIdOf(ctx);
  return withSalesAudit(ctx, async (tx) => {
    const quotation = await tx.quotation.findFirst({ where: { id: quotationId, organizationId } });
    if (!quotation) throw new NotFoundError('Quotation', quotationId);
    if (quotation.status !== 'DRAFT') throw new ConflictError(`Cannot submit a quotation in ${quotation.status} status.`);
    const request = await createApprovalRequest({
      organizationId,
      entityType: 'QUOTATION',
      entityId: quotation.id,
      amount: Number(quotation.totalAmount),
      currencyCode: quotation.currencyCode,
      submittedById: ctx.actor.userId,
      context: {
        organizationId,
        entityType: 'QUOTATION',
        entityId: quotation.id,
        submittedById: ctx.actor.userId,
        amount: Number(quotation.totalAmount),
        currencyCode: quotation.currencyCode,
        transactionDate: quotation.quoteDate,
        counterpartyId: quotation.customerId,
      },
    }, tx);
    const updated = await tx.quotation.update({
      where: { id: quotation.id },
      data: { status: 'SUBMITTED', submittedById: ctx.actor.userId, submittedAt: new Date() },
    });
    await auditSalesChange(tx, ctx, {
      action: 'QUOTATION_SUBMITTED',
      entityType: 'QUOTATION',
      entityId: quotation.id,
      entityLabel: quotation.number,
      description: `Submitted quotation ${quotation.number} for approval`,
      changes: { status: { from: 'DRAFT', to: 'SUBMITTED' } },
      metadata: { approvalRequestId: request.id },
    });
    return updated;
  });
}

export async function decideQuotation(ctx: RequestContext, quotationId: string, decision: 'APPROVED' | 'REJECTED', reason?: string) {
  await authorize(ctx, { module: 'QUOTATIONS', action: decision === 'APPROVED' ? 'APPROVE' : 'REJECT' });
  const organizationId = organizationIdOf(ctx);
  return withSalesAudit(ctx, async (tx) => {
    const quotation = await tx.quotation.findFirst({ where: { id: quotationId, organizationId } });
    if (!quotation) throw new NotFoundError('Quotation', quotationId);
    if (quotation.status !== 'SUBMITTED') throw new ConflictError(`Cannot decide a quotation in ${quotation.status} status.`);
    if (quotation.submittedById === ctx.actor.userId) throw new ConflictError('A quotation submitter cannot approve their own quotation.');
    const approval = await tx.approvalRequest.findFirst({
      where: { organizationId, entityType: 'QUOTATION', entityId: quotation.id, status: { in: ['PENDING', 'IN_PROGRESS'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!approval) throw new ConflictError('The quotation has no pending approval request.');
    const result = await advanceRequest(approval.id, decision, {
      userId: ctx.actor.userId, fullName: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes,
    }, { reason, tx });
    const updated = await tx.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    if (result.isComplete && decision === 'APPROVED') {
      await auditSalesChange(tx, ctx, {
        action: 'QUOTATION_APPROVED',
        entityType: 'QUOTATION',
        entityId: quotation.id,
        entityLabel: quotation.number,
        description: `Approved quotation ${quotation.number}`,
        changes: { status: { from: 'SUBMITTED', to: 'APPROVED' } },
      });
    }
    return updated;
  });
}

export async function sendQuotation(ctx: RequestContext, quotationId: string) {
  await authorize(ctx, { module: 'QUOTATIONS', action: 'EDIT' });
  const organizationId = organizationIdOf(ctx);
  return withSalesAudit(ctx, async (tx) => {
    const quotation = await tx.quotation.findFirst({ where: { id: quotationId, organizationId } });
    if (!quotation) throw new NotFoundError('Quotation', quotationId);
    if (quotation.status !== 'APPROVED') throw new ConflictError('Only an approved quotation can be sent.');
    if (quotation.validUntil < new Date(new Date().toISOString().slice(0, 10))) {
      const expired = await tx.quotation.update({ where: { id: quotation.id }, data: { status: 'EXPIRED' } });
      await auditSalesChange(tx, ctx, {
        action: 'QUOTATION_EXPIRED', entityType: 'QUOTATION', entityId: quotation.id,
        entityLabel: quotation.number, description: `Expired quotation ${quotation.number}`,
        changes: { status: { from: 'APPROVED', to: 'EXPIRED' } },
      });
      return expired;
    }
    const updated = await tx.quotation.update({ where: { id: quotation.id }, data: { status: 'SENT', sentAt: new Date() } });
    await auditSalesChange(tx, ctx, {
      action: 'QUOTATION_SENT', entityType: 'QUOTATION', entityId: quotation.id,
      entityLabel: quotation.number, description: `Sent quotation ${quotation.number}`,
      changes: { status: { from: 'APPROVED', to: 'SENT' } },
    });
    return updated;
  });
}

export async function acceptQuotation(ctx: RequestContext, quotationId: string) {
  await authorize(ctx, { module: 'QUOTATIONS', action: 'EDIT' });
  const organizationId = organizationIdOf(ctx);
  return withSalesAudit(ctx, async (tx) => {
    const quotation = await tx.quotation.findFirst({ where: { id: quotationId, organizationId } });
    if (!quotation) throw new NotFoundError('Quotation', quotationId);
    if (quotation.status !== 'SENT') throw new ConflictError('Only a sent quotation can be accepted.');
    if (quotation.validUntil < new Date(new Date().toISOString().slice(0, 10))) {
      const expired = await tx.quotation.update({ where: { id: quotation.id }, data: { status: 'EXPIRED' } });
      await auditSalesChange(tx, ctx, {
        action: 'QUOTATION_EXPIRED', entityType: 'QUOTATION', entityId: quotation.id,
        entityLabel: quotation.number, description: `Expired quotation ${quotation.number}`,
        changes: { status: { from: 'SENT', to: 'EXPIRED' } },
      });
      return expired;
    }
    const updated = await tx.quotation.update({ where: { id: quotation.id }, data: { status: 'ACCEPTED', acceptedAt: new Date() } });
    await auditSalesChange(tx, ctx, {
      action: 'QUOTATION_ACCEPTED', entityType: 'QUOTATION', entityId: quotation.id,
      entityLabel: quotation.number, description: `Accepted quotation ${quotation.number}`,
      changes: { status: { from: 'SENT', to: 'ACCEPTED' } },
    });
    return updated;
  });
}

export interface QuotationInvoiceConversion {
  invoices: Array<{
    invoiceDate: string;
    dueDate: string;
    lines: Array<{ quotationLineId: string; quantity: string | number; accountId: string; taxRate?: string | number; taxAccountId?: string }>;
  }>;
}

export async function convertQuotation(ctx: RequestContext, quotationId: string, input: QuotationInvoiceConversion) {
  await authorize(ctx, { module: 'INVOICES', action: 'CREATE' });
  const organizationId = organizationIdOf(ctx);
  if (input.invoices.length === 0) throw new ValidationError('Provide at least one invoice to convert the quotation.');
  const outcome = await withSalesAudit(ctx, async (tx) => {
    const quotation = await tx.quotation.findFirst({
      where: { id: quotationId, organizationId },
      include: { lines: true },
    });
    if (!quotation) throw new NotFoundError('Quotation', quotationId);
    if (quotation.status !== 'ACCEPTED') throw new ConflictError('Only an accepted quotation can be converted.');

    const remaining = new Map(quotation.lines.map((line) => [line.id, line.quantity.minus(line.invoicedQuantity)]));
    let conversionTotal = new Prisma.Decimal(0);
    const quoteLineMap = new Map(quotation.lines.map((line) => [line.id, line]));
    const created = [];
    for (const invoice of input.invoices) {
      if (invoice.lines.length === 0) throw new ValidationError('Every converted invoice needs at least one line.');
      for (const line of invoice.lines) {
        const left = remaining.get(line.quotationLineId);
        const quantity = new Prisma.Decimal(line.quantity);
        if (!left || !quantity.greaterThan(0) || quantity.greaterThan(left)) {
          throw new ValidationError('The conversion quantity exceeds the quotation line quantity still available.');
        }
        remaining.set(line.quotationLineId, left.minus(quantity));
        const netAmount = quantity.times(quoteLineMap.get(line.quotationLineId)!.unitPrice);
        const rate = line.taxRate === undefined ? new Prisma.Decimal(0) : new Prisma.Decimal(line.taxRate);
        if (rate.lessThan(0)) throw new ValidationError('Tax rates cannot be negative.');
        conversionTotal = conversionTotal.plus(netAmount).plus(netAmount.times(rate).dividedBy(100).toDecimalPlaces(6));
      }
    }
    const credit = await evaluateCustomerInvoiceCredit(tx, {
      organizationId,
      customerId: quotation.customerId,
      invoiceAmount: conversionTotal,
      actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
    });
    if (!credit.allowed) return { denied: credit.reason ?? 'The customer credit check failed.', result: null };

    for (const invoice of input.invoices) {
      created.push(await createInvoiceFromQuotation(tx, ctx, organizationId, quotation, invoice));
    }
    for (const [quotationLineId, remainingQuantity] of remaining) {
      const line = quotation.lines.find((candidate) => candidate.id === quotationLineId);
      if (line) {
        await tx.quotationLine.update({
          where: { id: line.id },
          data: { invoicedQuantity: line.quantity.minus(remainingQuantity) },
        });
      }
    }
    const fullyConverted = [...remaining.values()].every((quantity) => quantity.isZero());
    const updated = await tx.quotation.update({
      where: { id: quotation.id },
      data: { status: fullyConverted ? 'CONVERTED' : 'ACCEPTED', convertedAt: new Date() },
      include: { invoices: true },
    });
    await auditSalesChange(tx, ctx, {
      action: 'QUOTATION_CONVERTED', entityType: 'QUOTATION', entityId: quotation.id,
      entityLabel: quotation.number,
      description: `Converted quotation ${quotation.number} to ${created.length} invoice(s)`,
      changes: { status: { from: 'ACCEPTED', to: updated.status } },
      metadata: { invoiceIds: created.map((invoice) => invoice.id) },
    });
    return { denied: null, result: { quotation: updated, invoices: created } };
  });
  if (outcome.denied) throw new ConflictError(outcome.denied);
  return outcome.result;
}

export async function updateQuotationDraft(ctx: RequestContext, quotationId: string, input: CreateQuotationInput) {
  await authorize(ctx, { module: 'QUOTATIONS', action: 'EDIT' });
  const organizationId = organizationIdOf(ctx);
  const quoteDate = asDate(input.quoteDate, 'quoteDate');
  const validUntil = asDate(input.validUntil, 'validUntil');
  if (validUntil < quoteDate) throw new ValidationError('A quotation cannot expire before its quote date.');
  const lines = requireQuotationLines(input.lines);
  const subtotal = lines.reduce((sum, line) => sum.plus(line.amount), new Prisma.Decimal(0));
  return withSalesAudit(ctx, async (tx) => {
    const quotation = await tx.quotation.findFirst({ where: { id: quotationId, organizationId } });
    if (!quotation) throw new NotFoundError('Quotation', quotationId);
    if (quotation.status !== 'DRAFT') throw new ConflictError('Only draft quotations can be edited.');
    const customer = await tx.customer.findFirst({
      where: { id: input.customerId, organizationId, deletedAt: null, status: 'ACTIVE', masterDataStatus: 'ACTIVE' },
      select: { id: true },
    });
    if (!customer) throw new NotFoundError('Active customer', input.customerId);
    await assertCurrency(tx, input.currencyCode);
    await tx.quotationLine.deleteMany({ where: { quotationId } });
    const updated = await tx.quotation.update({
      where: { id: quotation.id },
      data: {
        customerId: customer.id, quoteDate, validUntil, currencyCode: input.currencyCode,
        reference: input.reference?.trim() || null, notes: input.notes?.trim() || null,
        subtotal, taxAmount: 0, totalAmount: subtotal, lines: { create: lines },
      },
      include: { lines: true },
    });
    await auditSalesChange(tx, ctx, {
      action: 'QUOTATION_CREATED', entityType: 'QUOTATION', entityId: quotation.id,
      entityLabel: quotation.number, description: `Updated draft quotation ${quotation.number}`,
      changes: { totalAmount: { from: quotation.totalAmount.toString(), to: subtotal.toString() } },
    });
    return updated;
  });
}

export async function cancelDraftQuotation(ctx: RequestContext, quotationId: string, reason: string) {
  await authorize(ctx, { module: 'QUOTATIONS', action: 'EDIT' });
  const organizationId = organizationIdOf(ctx);
  if (reason.trim().length < 5) throw new ValidationError('A cancellation reason of at least five characters is required.');
  return withSalesAudit(ctx, async (tx) => {
    const quotation = await tx.quotation.findFirst({ where: { id: quotationId, organizationId } });
    if (!quotation) throw new NotFoundError('Quotation', quotationId);
    if (quotation.status !== 'DRAFT') throw new ConflictError('Only draft quotations can be cancelled here.');
    const updated = await tx.quotation.update({ where: { id: quotation.id }, data: { status: 'CANCELLED' } });
    await auditSalesChange(tx, ctx, {
      action: 'CONFIGURATION_CHANGES', entityType: 'QUOTATION', entityId: quotation.id,
      entityLabel: quotation.number, description: `Cancelled draft quotation ${quotation.number}`,
      changes: { status: { from: 'DRAFT', to: 'CANCELLED' } }, metadata: { reason: reason.trim() },
    });
    return updated;
  });
}

export async function expireQuotation(ctx: RequestContext, quotationId: string) {
  await authorize(ctx, { module: 'QUOTATIONS', action: 'EDIT' });
  const organizationId = organizationIdOf(ctx);
  return withSalesAudit(ctx, async (tx) => {
    const quotation = await tx.quotation.findFirst({ where: { id: quotationId, organizationId } });
    if (!quotation) throw new NotFoundError('Quotation', quotationId);
    if (!['APPROVED', 'SENT'].includes(quotation.status)) throw new ConflictError('Only an approved or sent quotation can expire.');
    if (quotation.validUntil >= new Date(new Date().toISOString().slice(0, 10))) throw new ConflictError('The quotation has not reached its expiry date.');
    const updated = await tx.quotation.update({ where: { id: quotation.id }, data: { status: 'EXPIRED' } });
    await auditSalesChange(tx, ctx, {
      action: 'QUOTATION_EXPIRED', entityType: 'QUOTATION', entityId: quotation.id,
      entityLabel: quotation.number, description: `Expired quotation ${quotation.number}`,
      changes: { status: { from: quotation.status, to: 'EXPIRED' } },
    });
    return updated;
  });
}

