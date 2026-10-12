import { Prisma } from '@/generated/prisma/client';
import type { AdjustmentReasonCode } from '@/generated/prisma/client';
import { advanceRequest, createApprovalRequest } from '@/lib/approvals/engine';
import { authorize } from '@/lib/kernel/authorize';
import type { RequestContext } from '@/lib/kernel/context';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/kernel/errors';
import { prisma } from '@/lib/db/prisma';
import type { Tx } from '@/lib/db/prisma';
import { auditSalesChange, createAndPostJournalEntry, findControlAccount, invoiceOutstanding, organizationIdOf, syncInvoiceStatusAndReceivable, withSalesAudit } from './common';

export interface CreateAdjustmentNoteInput {
  invoiceId: string;
  reasonCode: AdjustmentReasonCode;
  reason: string;
  amount: string | number;
  taxAmount?: string | number;
}

type NoteKind = 'CREDIT_NOTE' | 'DEBIT_NOTE';

async function loadInvoiceForNote(tx: Tx, organizationId: string, invoiceId: string) {
  const invoice = await tx.invoice.findFirst({
    where: { id: invoiceId, organizationId },
    include: { lines: true },
  });
  if (!invoice) throw new NotFoundError('Invoice', invoiceId);
  if (invoice.status === 'DRAFT' || invoice.status === 'SUBMITTED' || invoice.status === 'APPROVED' || invoice.status === 'REJECTED' || invoice.status === 'CANCELLED') {
    throw new ConflictError('Adjustment notes require a sent invoice.');
  }
  return invoice;
}

async function createNote(ctx: RequestContext, kind: NoteKind, input: CreateAdjustmentNoteInput) {
  const module = kind === 'CREDIT_NOTE' ? 'CREDIT_NOTES' : 'DEBIT_NOTES';
  await authorize(ctx, { module, action: 'CREATE' });
  const organizationId = organizationIdOf(ctx);
  const amount = new Prisma.Decimal(input.amount);
  const taxAmount = new Prisma.Decimal(input.taxAmount ?? 0);
  if (!amount.greaterThan(0) || taxAmount.lessThan(0) || input.reason.trim().length < 5) {
    throw new ValidationError('An adjustment note needs a positive amount, non-negative tax, and a reason of at least five characters.');
  }
  return withSalesAudit(ctx, async (tx) => {
    const invoice = await loadInvoiceForNote(tx, organizationId, input.invoiceId);
    if (kind === 'CREDIT_NOTE') {
      const balance = await invoiceOutstanding(tx, invoice.id, invoice.totalAmount);
      if (amount.plus(taxAmount).greaterThan(balance.outstanding)) {
        throw new ConflictError('A credit note cannot exceed the invoice outstanding balance.');
      }
    }
    if (taxAmount.greaterThan(0) && !invoice.lines.some((line) => line.taxAccountId)) {
      throw new ValidationError('The invoice has no tax account available for this adjustment.');
    }
    const number = await tx.documentSequence.upsert({
      where: { organizationId_type: { organizationId, type: kind } },
      create: { organizationId, type: kind, lastNumber: 1 },
      update: { lastNumber: { increment: 1 } },
      select: { lastNumber: true },
    });
    const code = kind === 'CREDIT_NOTE' ? 'CN' : 'DN';
    const documentNumber = `${code}-${String(number.lastNumber).padStart(6, '0')}`;
    const note = kind === 'CREDIT_NOTE'
      ? await tx.creditNote.create({
          data: {
            organizationId, invoiceId: invoice.id, number: documentNumber,
            reasonCode: input.reasonCode, reason: input.reason.trim(), amount, taxAmount,
            createdById: ctx.actor.userId,
          },
        })
      : await tx.debitNote.create({
          data: {
            organizationId, invoiceId: invoice.id, number: documentNumber,
            reasonCode: input.reasonCode, reason: input.reason.trim(), amount, taxAmount,
            createdById: ctx.actor.userId,
          },
        });
    await auditSalesChange(tx, ctx, {
      action: kind === 'CREDIT_NOTE' ? 'CREDIT_NOTE_CREATED' : 'DEBIT_NOTE_CREATED',
      entityType: kind,
      entityId: note.id,
      entityLabel: note.number,
      description: `Created ${kind === 'CREDIT_NOTE' ? 'credit' : 'debit'} note ${note.number}`,
      changes: { status: { from: null, to: 'DRAFT' } },
      metadata: { invoiceId: invoice.id, reasonCode: input.reasonCode, amount: amount.toString(), taxAmount: taxAmount.toString() },
    });
    return note;
  });
}

export function createCreditNote(ctx: RequestContext, input: CreateAdjustmentNoteInput) {
  return createNote(ctx, 'CREDIT_NOTE', input);
}

export function createDebitNote(ctx: RequestContext, input: CreateAdjustmentNoteInput) {
  return createNote(ctx, 'DEBIT_NOTE', input);
}

export async function listCreditNotes(ctx: RequestContext) {
  await authorize(ctx, { module: 'CREDIT_NOTES', action: 'VIEW' });
  return prisma.creditNote.findMany({ where: { organizationId: organizationIdOf(ctx) }, include: { invoice: true }, orderBy: [{ createdAt: 'desc' }, { number: 'desc' }] });
}

export async function listDebitNotes(ctx: RequestContext) {
  await authorize(ctx, { module: 'DEBIT_NOTES', action: 'VIEW' });
  return prisma.debitNote.findMany({ where: { organizationId: organizationIdOf(ctx) }, include: { invoice: true }, orderBy: [{ createdAt: 'desc' }, { number: 'desc' }] });
}

export async function getCreditNote(ctx: RequestContext, noteId: string) {
  await authorize(ctx, { module: 'CREDIT_NOTES', action: 'VIEW' });
  const note = await prisma.creditNote.findFirst({ where: { id: noteId, organizationId: organizationIdOf(ctx) }, include: { invoice: true } });
  if (!note) throw new NotFoundError('Credit note', noteId);
  return note;
}

export async function getDebitNote(ctx: RequestContext, noteId: string) {
  await authorize(ctx, { module: 'DEBIT_NOTES', action: 'VIEW' });
  const note = await prisma.debitNote.findFirst({ where: { id: noteId, organizationId: organizationIdOf(ctx) }, include: { invoice: true } });
  if (!note) throw new NotFoundError('Debit note', noteId);
  return note;
}

export async function updateAdjustmentNoteDraft(ctx: RequestContext, kind: NoteKind, noteId: string, input: { reasonCode?: AdjustmentReasonCode; reason?: string }) {
  const module = kind === 'CREDIT_NOTE' ? 'CREDIT_NOTES' : 'DEBIT_NOTES';
  await authorize(ctx, { module, action: 'EDIT' });
  const organizationId = organizationIdOf(ctx);
  return withSalesAudit(ctx, async (tx) => {
    const note = kind === 'CREDIT_NOTE'
      ? await tx.creditNote.findFirst({ where: { id: noteId, organizationId } })
      : await tx.debitNote.findFirst({ where: { id: noteId, organizationId } });
    if (!note) throw new NotFoundError(kind === 'CREDIT_NOTE' ? 'Credit note' : 'Debit note', noteId);
    if (note.status !== 'DRAFT') throw new ConflictError('Only draft adjustment notes can be edited.');
    if (input.reason !== undefined && input.reason.trim().length < 5) throw new ValidationError('A reason of at least five characters is required.');
    return kind === 'CREDIT_NOTE'
      ? tx.creditNote.update({ where: { id: note.id }, data: { reasonCode: input.reasonCode, reason: input.reason?.trim() } })
      : tx.debitNote.update({ where: { id: note.id }, data: { reasonCode: input.reasonCode, reason: input.reason?.trim() } });
  });
}

export async function cancelDraftAdjustmentNote(ctx: RequestContext, kind: NoteKind, noteId: string, reason: string) {
  const module = kind === 'CREDIT_NOTE' ? 'CREDIT_NOTES' : 'DEBIT_NOTES';
  await authorize(ctx, { module, action: 'EDIT' });
  const organizationId = organizationIdOf(ctx);
  if (reason.trim().length < 5) throw new ValidationError('A cancellation reason of at least five characters is required.');
  return withSalesAudit(ctx, async (tx) => {
    const note = kind === 'CREDIT_NOTE'
      ? await tx.creditNote.findFirst({ where: { id: noteId, organizationId } })
      : await tx.debitNote.findFirst({ where: { id: noteId, organizationId } });
    if (!note) throw new NotFoundError(kind === 'CREDIT_NOTE' ? 'Credit note' : 'Debit note', noteId);
    if (note.status !== 'DRAFT') throw new ConflictError('Only draft adjustment notes can be cancelled here.');
    const updated = kind === 'CREDIT_NOTE'
      ? await tx.creditNote.update({ where: { id: note.id }, data: { status: 'CANCELLED' } })
      : await tx.debitNote.update({ where: { id: note.id }, data: { status: 'CANCELLED' } });
    await auditSalesChange(tx, ctx, {
      action: 'CONFIGURATION_CHANGES', entityType: kind, entityId: note.id,
      entityLabel: note.number, description: `Cancelled draft adjustment note ${note.number}`,
      changes: { status: { from: 'DRAFT', to: 'CANCELLED' } }, metadata: { reason: reason.trim() },
    });
    return updated;
  });
}

async function submitNote(ctx: RequestContext, kind: NoteKind, noteId: string) {
  const module = kind === 'CREDIT_NOTE' ? 'CREDIT_NOTES' : 'DEBIT_NOTES';
  await authorize(ctx, { module, action: 'SUBMIT' });
  const organizationId = organizationIdOf(ctx);
  return withSalesAudit(ctx, async (tx) => {
    const note = kind === 'CREDIT_NOTE'
      ? await tx.creditNote.findFirst({ where: { id: noteId, organizationId }, include: { invoice: true } })
      : await tx.debitNote.findFirst({ where: { id: noteId, organizationId }, include: { invoice: true } });
    if (!note) throw new NotFoundError(kind === 'CREDIT_NOTE' ? 'Credit note' : 'Debit note', noteId);
    if (note.status !== 'DRAFT') throw new ConflictError(`Cannot submit a note in ${note.status} status.`);
    const entityType = kind;
    const total = note.amount.plus(note.taxAmount);
    const request = await createApprovalRequest({
      organizationId,
      entityType,
      entityId: note.id,
      amount: Number(total),
      currencyCode: note.invoice.currencyCode,
      submittedById: ctx.actor.userId,
      context: {
        organizationId,
        entityType,
        entityId: note.id,
        submittedById: ctx.actor.userId,
        amount: Number(total),
        currencyCode: note.invoice.currencyCode,
        transactionDate: new Date(),
        counterpartyId: note.invoice.customerId ?? note.invoice.supplierId,
      },
    }, tx);
    const updated = kind === 'CREDIT_NOTE'
      ? await tx.creditNote.update({ where: { id: note.id }, data: { status: 'SUBMITTED' } })
      : await tx.debitNote.update({ where: { id: note.id }, data: { status: 'SUBMITTED' } });
    await auditSalesChange(tx, ctx, {
      action: 'APPROVAL_REQUEST_SUBMITTED', entityType: kind, entityId: note.id,
      entityLabel: note.number, description: `Submitted adjustment note ${note.number} for approval`,
      changes: { status: { from: 'DRAFT', to: 'SUBMITTED' } }, metadata: { approvalRequestId: request.id },
    });
    return updated;
  });
}

export function submitCreditNote(ctx: RequestContext, noteId: string) {
  return submitNote(ctx, 'CREDIT_NOTE', noteId);
}

export function submitDebitNote(ctx: RequestContext, noteId: string) {
  return submitNote(ctx, 'DEBIT_NOTE', noteId);
}

function distribute(amount: Prisma.Decimal, weights: Prisma.Decimal[]) {
  const totalWeight = weights.reduce((sum, weight) => sum.plus(weight), new Prisma.Decimal(0));
  if (!totalWeight.greaterThan(0)) throw new ValidationError('The original invoice lines have no amount available for adjustment.');
  let distributed = new Prisma.Decimal(0);
  return weights.map((weight, index) => {
    const value = index === weights.length - 1
      ? amount.minus(distributed)
      : amount.times(weight).dividedBy(totalWeight).toDecimalPlaces(6);
    distributed = distributed.plus(value);
    return value;
  });
}

async function postNote(tx: Tx, ctx: RequestContext, kind: NoteKind, noteId: string) {
  const organizationId = organizationIdOf(ctx);
  const note = kind === 'CREDIT_NOTE'
    ? await tx.creditNote.findFirst({ where: { id: noteId, organizationId }, include: { invoice: { include: { lines: true } } } })
    : await tx.debitNote.findFirst({ where: { id: noteId, organizationId }, include: { invoice: { include: { lines: true } } } });
  if (!note) throw new NotFoundError(kind === 'CREDIT_NOTE' ? 'Credit note' : 'Debit note', noteId);
  if (note.status !== 'APPROVED') throw new ConflictError(`Only an approved ${kind.toLowerCase().replace('_', ' ')} can be applied.`);
  if (note.createdById === ctx.actor.userId) throw new ConflictError('The note creator cannot post their own adjustment note.');
  const invoice = note.invoice;
  const sales = invoice.direction === 'RECEIVABLE';
  const credit = kind === 'CREDIT_NOTE';
  const control = await findControlAccount(tx, organizationId, sales ? 'RECEIVABLE' : 'PAYABLE');
  const netShares = distribute(note.amount, invoice.lines.map((line) => line.amount));
  const lines: Array<{ accountId: string; debit: Prisma.Decimal; credit: Prisma.Decimal; description: string }> = [];
  const zero = new Prisma.Decimal(0);

  const taxShares = note.taxAmount.greaterThan(0)
    ? distribute(note.taxAmount, invoice.lines.map((line) => line.taxAmount))
    : invoice.lines.map(() => zero);
  const controlAmount = note.amount.plus(note.taxAmount);
  const addIncomeExpenseLines = (debit: boolean) => {
    invoice.lines.forEach((line, index) => {
      const share = netShares[index] ?? zero;
      if (share.greaterThan(0)) lines.push({
        accountId: line.accountId,
        debit: debit ? share : zero,
        credit: debit ? zero : share,
        description: `${credit ? 'Credit' : 'Debit'} note ${note.number}: ${line.description}`,
      });
    });
  };
  const addTaxLines = (debit: boolean) => {
    invoice.lines.forEach((line, index) => {
      const share = taxShares[index] ?? zero;
      if (share.greaterThan(0)) {
        if (!line.taxAccountId) throw new ValidationError('An invoice tax account is missing for this adjustment.');
        lines.push({
          accountId: line.taxAccountId,
          debit: debit ? share : zero,
          credit: debit ? zero : share,
          description: `Tax adjustment for ${note.number}: ${line.description}`,
        });
      }
    });
  };

  if (sales && credit) {
    addIncomeExpenseLines(true);
    addTaxLines(true);
    lines.push({ accountId: control.id, debit: zero, credit: controlAmount, description: `Reduce receivable for ${note.number}` });
  } else if (sales) {
    lines.push({ accountId: control.id, debit: controlAmount, credit: zero, description: `Increase receivable for ${note.number}` });
    addIncomeExpenseLines(false);
    addTaxLines(false);
  } else if (credit) {
    lines.push({ accountId: control.id, debit: controlAmount, credit: zero, description: `Reduce payable for ${note.number}` });
    addIncomeExpenseLines(false);
    addTaxLines(false);
  } else {
    addIncomeExpenseLines(true);
    addTaxLines(true);
    lines.push({ accountId: control.id, debit: zero, credit: controlAmount, description: `Increase payable for ${note.number}` });
  }

  const journalEntryId = await createAndPostJournalEntry(tx, ctx, {
    organizationId,
    date: new Date(),
    currencyCode: invoice.currencyCode,
    source: kind,
    reference: note.number,
    description: `${kind === 'CREDIT_NOTE' ? 'Credit' : 'Debit'} note for invoice ${invoice.number}`,
    submittedById: note.createdById,
    lines,
  });
  const updated = kind === 'CREDIT_NOTE'
    ? await tx.creditNote.update({ where: { id: note.id }, data: { status: 'APPLIED', appliedAt: new Date(), journalEntryId } })
    : await tx.debitNote.update({ where: { id: note.id }, data: { status: 'APPLIED', appliedAt: new Date(), journalEntryId } });
  await syncInvoiceStatusAndReceivable(tx, invoice.id, organizationId);
  await auditSalesChange(tx, ctx, {
    action: kind === 'CREDIT_NOTE' ? 'CREDIT_NOTE_APPLIED' : 'DEBIT_NOTE_APPLIED',
    entityType: kind, entityId: note.id, entityLabel: note.number,
    description: `Applied adjustment note ${note.number} to invoice ${invoice.number}`,
    changes: { status: { from: 'APPROVED', to: 'APPLIED' }, journalEntryId: { from: null, to: journalEntryId } },
    metadata: { invoiceId: invoice.id, amount: note.amount.toString(), taxAmount: note.taxAmount.toString() },
  });
  return updated;
}

async function decideNote(ctx: RequestContext, kind: NoteKind, noteId: string, decision: 'APPROVED' | 'REJECTED', reason?: string) {
  const module = kind === 'CREDIT_NOTE' ? 'CREDIT_NOTES' : 'DEBIT_NOTES';
  await authorize(ctx, { module, action: decision === 'APPROVED' ? 'APPROVE' : 'REJECT' });
  const organizationId = organizationIdOf(ctx);
  return withSalesAudit(ctx, async (tx) => {
    const note = kind === 'CREDIT_NOTE'
      ? await tx.creditNote.findFirst({ where: { id: noteId, organizationId } })
      : await tx.debitNote.findFirst({ where: { id: noteId, organizationId } });
    if (!note) throw new NotFoundError(kind === 'CREDIT_NOTE' ? 'Credit note' : 'Debit note', noteId);
    if (note.status !== 'SUBMITTED') throw new ConflictError(`Cannot decide a note in ${note.status} status.`);
    if (note.createdById === ctx.actor.userId) throw new ConflictError('A note submitter cannot approve their own adjustment note.');
    const request = await tx.approvalRequest.findFirst({
      where: { organizationId, entityType: kind, entityId: note.id, status: { in: ['PENDING', 'IN_PROGRESS'] } },
      orderBy: { createdAt: 'desc' }, select: { id: true },
    });
    if (!request) throw new ConflictError('The adjustment note has no pending approval request.');
    const result = await advanceRequest(request.id, decision, {
      userId: ctx.actor.userId, fullName: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes,
    }, { reason, tx });
    if (decision === 'APPROVED' && result.isComplete) return postNote(tx, ctx, kind, note.id);
    return kind === 'CREDIT_NOTE'
      ? tx.creditNote.findUniqueOrThrow({ where: { id: note.id } })
      : tx.debitNote.findUniqueOrThrow({ where: { id: note.id } });
  });
}

export function decideCreditNote(ctx: RequestContext, noteId: string, decision: 'APPROVED' | 'REJECTED', reason?: string) {
  return decideNote(ctx, 'CREDIT_NOTE', noteId, decision, reason);
}

export function decideDebitNote(ctx: RequestContext, noteId: string, decision: 'APPROVED' | 'REJECTED', reason?: string) {
  return decideNote(ctx, 'DEBIT_NOTE', noteId, decision, reason);
}

