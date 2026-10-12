import { Prisma, type AuditAction, type AuditEntityType, type CredentialStatus } from '@/generated/prisma/client';
import { prisma } from '@/lib/db/prisma';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { authorize } from '@/lib/kernel/authorize';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/kernel/errors';
import type { RequestContext } from '@/lib/kernel/context';
import { calculateTax, selectEffectiveTaxRule } from './calculator';
import type {
  ComplianceDocumentCreateInput,
  CredentialCreateInput,
  CredentialUpdateInput,
  TaxObligationCreateInput,
  TaxObligationUpdateInput,
  TaxPaymentCreateInput,
  TaxPaymentUpdateInput,
  TaxRuleCreateInput,
  TaxRuleUpdateInput,
} from './schemas';

type TaxAction = 'VIEW' | 'CREATE' | 'EDIT' | 'CONFIGURE' | 'APPROVE' | 'ADMINISTER' | 'SUBMIT';

function organizationId(ctx: RequestContext): string {
  if (!ctx.actor.organizationId) throw new ValidationError('An organization context is required.');
  return ctx.actor.organizationId;
}

async function access(ctx: RequestContext, action: TaxAction): Promise<string> {
  const orgId = organizationId(ctx);
  await authorize(ctx, { module: 'TAX_COMPLIANCE', action });
  return orgId;
}

function auditContext(ctx: RequestContext, orgId: string) {
  return {
    organizationId: orgId,
    actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
    sessionId: ctx.actor.sessionId,
  };
}

async function audit(
  tx: Parameters<Parameters<typeof withAudit>[1]>[0],
  ctx: RequestContext,
  action: AuditAction,
  entityType: AuditEntityType,
  entityId: string,
  label: string,
  description: string,
  metadata?: Record<string, Prisma.InputJsonValue | null>,
) {
  await writeAuditEntry(
    tx,
    { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
    { action, entityType, entityId, entityLabel: label, description, metadata },
    {
      organizationId: ctx.actor.organizationId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
      sessionId: ctx.actor.sessionId,
    },
  );
}

function toDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined || value === null) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ValidationError('A date field is invalid.');
  return date;
}

function toDecimal(value: string | null | undefined): Prisma.Decimal | null | undefined {
  if (value === undefined || value === null) return value;
  const decimal = new Prisma.Decimal(value);
  if (!decimal.isFinite()) throw new ValidationError('A decimal field is invalid.');
  return decimal;
}

function assertRuleConsistency(input: Pick<TaxRuleCreateInput, 'isInclusive' | 'calculationBasis' | 'ratePercent'>) {
  if (input.isInclusive !== (input.calculationBasis === 'INCLUSIVE')) {
    throw new ValidationError('Inclusive flag and calculation basis must agree.');
  }
  if (input.calculationBasis !== 'NOT_APPLICABLE' && input.ratePercent == null) {
    throw new ValidationError('An applicable rule needs a configured rate.');
  }
  if (input.ratePercent != null && new Prisma.Decimal(input.ratePercent).isNegative()) {
    throw new ValidationError('A tax rate cannot be negative.');
  }
}

export async function listTaxRules(ctx: RequestContext) {
  const orgId = await access(ctx, 'VIEW');
  return prisma.taxRule.findMany({
    where: { organizationId: orgId },
    include: { payableAccount: { select: { id: true, code: true, name: true } }, receivableAccount: { select: { id: true, code: true, name: true } } },
    orderBy: [{ isActive: 'desc' }, { effectiveFrom: 'desc' }, { code: 'asc' }],
  });
}

export async function getTaxRule(ctx: RequestContext, id: string) {
  const orgId = await access(ctx, 'VIEW');
  const row = await prisma.taxRule.findFirst({
    where: { id, organizationId: orgId },
    include: { payableAccount: { select: { id: true, code: true, name: true } }, receivableAccount: { select: { id: true, code: true, name: true } } },
  });
  if (!row) throw new NotFoundError('Tax rule', id);
  return row;
}

export async function createTaxRule(ctx: RequestContext, input: TaxRuleCreateInput) {
  const orgId = await access(ctx, 'CONFIGURE');
  assertRuleConsistency(input as Pick<TaxRuleCreateInput, 'isInclusive' | 'calculationBasis' | 'ratePercent'>);
  if (input.isVerified) await authorize(ctx, { module: 'TAX_COMPLIANCE', action: 'APPROVE' });
  await validateAccounts(orgId, input.payableAccountId, input.receivableAccountId);
  const created = await withAudit(auditContext(ctx, orgId), async (tx) => {
    const row = await tx.taxRule.create({
      data: {
        organizationId: orgId,
        code: input.code,
        name: input.name,
        type: input.type,
        jurisdiction: input.jurisdiction,
        ratePercent: toDecimal(input.ratePercent) ?? null,
        isInclusive: input.isInclusive,
        calculationBasis: input.calculationBasis,
        appliesWhenOrganizationRegistered: input.appliesWhenOrganizationRegistered,
        effectiveFrom: toDate(input.effectiveFrom)!,
        effectiveTo: toDate(input.effectiveTo) ?? null,
        isActive: input.isActive,
        payableAccountId: input.payableAccountId ?? null,
        receivableAccountId: input.receivableAccountId ?? null,
        roundingMode: input.roundingMode,
        minTaxableAmount: toDecimal(input.minTaxableAmount) ?? null,
        exemptionThreshold: toDecimal(input.exemptionThreshold) ?? null,
        verifiedByProfessionalOn: toDate(input.verifiedByProfessionalOn) ?? null,
        verifiedByProfessionalName: input.verifiedByProfessionalName ?? null,
        verificationReference: input.verificationReference ?? null,
        isVerified: input.isVerified ?? false,
        notes: input.notes ?? null,
        createdById: ctx.actor.userId,
      },
    });
    await audit(tx, ctx, 'TAX_RULE_CREATED', 'TAX_RULE', row.id, row.code, `Created tax rule ${row.code}`, {
      type: row.type, jurisdiction: row.jurisdiction, isVerified: row.isVerified,
    });
    return row;
  });
  return created;
}

export async function updateTaxRule(ctx: RequestContext, id: string, input: TaxRuleUpdateInput) {
  const orgId = organizationId(ctx);
  const verificationChange = input.isVerified !== undefined;
  await access(ctx, verificationChange ? 'APPROVE' : 'CONFIGURE');
  if (input.isVerified === false) await authorize(ctx, { module: 'TAX_COMPLIANCE', action: 'CONFIGURE' });
  const current = await prisma.taxRule.findFirst({ where: { id, organizationId: orgId } });
  if (!current) throw new NotFoundError('Tax rule', id);
  const merged = {
    isInclusive: input.isInclusive ?? current.isInclusive,
    calculationBasis: input.calculationBasis ?? current.calculationBasis,
    ratePercent: input.ratePercent === undefined ? current.ratePercent?.toString() ?? null : input.ratePercent,
  };
  assertRuleConsistency(merged);
  await validateAccounts(
    orgId,
    input.payableAccountId === undefined ? current.payableAccountId : input.payableAccountId,
    input.receivableAccountId === undefined ? current.receivableAccountId : input.receivableAccountId,
  );
  if (input.isVerified === true && (!input.verifiedByProfessionalName || !input.verifiedByProfessionalOn)) {
    throw new ValidationError('Professional name and verification date are required for sign-off.');
  }
  return withAudit(auditContext(ctx, orgId), async (tx) => {
    const row = await tx.taxRule.update({
      where: { id },
      data: {
        ...(input.code !== undefined ? { code: input.code } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.jurisdiction !== undefined ? { jurisdiction: input.jurisdiction } : {}),
        ...(input.ratePercent !== undefined ? { ratePercent: toDecimal(input.ratePercent) } : {}),
        ...(input.isInclusive !== undefined ? { isInclusive: input.isInclusive } : {}),
        ...(input.calculationBasis !== undefined ? { calculationBasis: input.calculationBasis } : {}),
        ...(input.appliesWhenOrganizationRegistered !== undefined ? { appliesWhenOrganizationRegistered: input.appliesWhenOrganizationRegistered } : {}),
        ...(input.effectiveFrom !== undefined ? { effectiveFrom: toDate(input.effectiveFrom)! } : {}),
        ...(input.effectiveTo !== undefined ? { effectiveTo: toDate(input.effectiveTo) } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.payableAccountId !== undefined ? { payableAccountId: input.payableAccountId } : {}),
        ...(input.receivableAccountId !== undefined ? { receivableAccountId: input.receivableAccountId } : {}),
        ...(input.roundingMode !== undefined ? { roundingMode: input.roundingMode } : {}),
        ...(input.minTaxableAmount !== undefined ? { minTaxableAmount: toDecimal(input.minTaxableAmount) } : {}),
        ...(input.exemptionThreshold !== undefined ? { exemptionThreshold: toDecimal(input.exemptionThreshold) } : {}),
        ...(input.verifiedByProfessionalOn !== undefined ? { verifiedByProfessionalOn: toDate(input.verifiedByProfessionalOn) } : {}),
        ...(input.verifiedByProfessionalName !== undefined ? { verifiedByProfessionalName: input.verifiedByProfessionalName } : {}),
        ...(input.verificationReference !== undefined ? { verificationReference: input.verificationReference } : {}),
        ...(input.isVerified !== undefined ? { isVerified: input.isVerified } : {}),
        ...(input.isVerified === false ? { verifiedByProfessionalOn: null, verifiedByProfessionalName: null, verificationReference: null } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
    });
    await audit(
      tx,
      ctx,
      input.isActive === false ? 'TAX_RULE_DEACTIVATED' : 'TAX_RULE_UPDATED',
      'TAX_RULE',
      row.id,
      row.code,
      input.isVerified === true ? `Verified tax rule ${row.code}` : `Updated tax rule ${row.code}`,
      { verified: row.isVerified, active: row.isActive },
    );
    return row;
  });
}

async function validateAccounts(orgId: string, payableAccountId?: string | null, receivableAccountId?: string | null) {
  const ids = [payableAccountId, receivableAccountId].filter((id): id is string => Boolean(id));
  if (ids.length === 0) return;
  const count = await prisma.account.count({ where: { organizationId: orgId, id: { in: ids } } });
  if (count !== ids.length) throw new ValidationError('Tax accounts must belong to the active organization.');
}

export async function deleteTaxRule(ctx: RequestContext, id: string) {
  const orgId = await access(ctx, 'CONFIGURE');
  const current = await prisma.taxRule.findFirst({ where: { id, organizationId: orgId } });
  if (!current) throw new NotFoundError('Tax rule', id);
  return updateTaxRule(ctx, id, { isActive: false });
}

export async function listTaxObligations(ctx: RequestContext, filters: { status?: string; period?: string } = {}) {
  const orgId = await access(ctx, 'VIEW');
  return prisma.taxObligation.findMany({
    where: {
      organizationId: orgId,
      ...(filters.status ? { status: filters.status as Prisma.EnumTaxObligationStatusFilter['equals'] } : {}),
      ...(filters.period ? { period: filters.period } : {}),
    },
    include: { taxRule: { select: { id: true, code: true, name: true, type: true, isVerified: true } }, payments: true },
    orderBy: [{ filingDueDate: 'asc' }, { period: 'desc' }],
  });
}

export async function getTaxObligation(ctx: RequestContext, id: string) {
  const orgId = await access(ctx, 'VIEW');
  const row = await prisma.taxObligation.findFirst({
    where: { id, organizationId: orgId },
    include: { taxRule: true, payments: { orderBy: { paidAt: 'desc' } }, complianceDocuments: { include: { document: true } } },
  });
  if (!row) throw new NotFoundError('Tax obligation', id);
  return row;
}

export async function createTaxObligation(ctx: RequestContext, input: TaxObligationCreateInput) {
  const orgId = await access(ctx, 'CREATE');
  const organization = await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { registrationStatus: true } });
  let status = input.status ?? 'PENDING';
  let taxableAmount = new Prisma.Decimal(input.taxableAmount);
  let taxAmount = new Prisma.Decimal(input.taxAmount);
  if (input.taxRuleId) {
    const rule = await prisma.taxRule.findFirst({ where: { id: input.taxRuleId, organizationId: orgId } });
    if (!rule) throw new NotFoundError('Tax rule', input.taxRuleId);
    if (rule.appliesWhenOrganizationRegistered && organization.registrationStatus !== 'REGISTERED') {
      status = 'NOT_APPLICABLE';
      taxableAmount = new Prisma.Decimal(0);
      taxAmount = new Prisma.Decimal(0);
    }
  }
  return withAudit(auditContext(ctx, orgId), async (tx) => {
    const row = await tx.taxObligation.create({
      data: {
        organizationId: orgId,
        taxRuleId: input.taxRuleId ?? null,
        period: input.period,
        direction: input.direction,
        status,
        filingDueDate: toDate(input.filingDueDate) ?? null,
        filedAt: toDate(input.filedAt) ?? null,
        taxableAmount,
        taxAmount,
        currencyCode: input.currencyCode,
        description: input.description ?? null,
        createdById: ctx.actor.userId,
      },
    });
    await audit(tx, ctx, 'TAX_OBLIGATION_CREATED', 'TAX_OBLIGATION', row.id, row.period, `Created tax obligation for ${row.period}`, { status: row.status });
    return row;
  });
}

export async function updateTaxObligation(ctx: RequestContext, id: string, input: TaxObligationUpdateInput) {
  const orgId = await access(ctx, 'EDIT');
  const current = await prisma.taxObligation.findFirst({ where: { id, organizationId: orgId } });
  if (!current) throw new NotFoundError('Tax obligation', id);
  if (current.status === 'PAID' || current.status === 'NOT_APPLICABLE') {
    throw new ConflictError(`A ${current.status.toLowerCase()} obligation cannot be edited.`);
  }
  if (input.taxRuleId) {
    const rule = await prisma.taxRule.findFirst({ where: { id: input.taxRuleId, organizationId: orgId } });
    if (!rule) throw new NotFoundError('Tax rule', input.taxRuleId);
  }
  return withAudit(auditContext(ctx, orgId), async (tx) => {
    const row = await tx.taxObligation.update({
      where: { id },
      data: {
        ...(input.taxRuleId !== undefined ? { taxRuleId: input.taxRuleId } : {}),
        ...(input.period !== undefined ? { period: input.period } : {}),
        ...(input.direction !== undefined ? { direction: input.direction } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.filingDueDate !== undefined ? { filingDueDate: toDate(input.filingDueDate) } : {}),
        ...(input.filedAt !== undefined ? { filedAt: toDate(input.filedAt) } : {}),
        ...(input.taxableAmount !== undefined ? { taxableAmount: new Prisma.Decimal(input.taxableAmount) } : {}),
        ...(input.taxAmount !== undefined ? { taxAmount: new Prisma.Decimal(input.taxAmount) } : {}),
        ...(input.currencyCode !== undefined ? { currencyCode: input.currencyCode } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
    });
    await audit(tx, ctx, 'TAX_OBLIGATION_UPDATED', 'TAX_OBLIGATION', row.id, row.period, `Updated tax obligation for ${row.period}`, { status: row.status });
    return row;
  });
}

export async function deleteTaxObligation(ctx: RequestContext, id: string) {
  const orgId = await access(ctx, 'ADMINISTER');
  const current = await prisma.taxObligation.findFirst({ where: { id, organizationId: orgId }, include: { _count: { select: { payments: true } } } });
  if (!current) throw new NotFoundError('Tax obligation', id);
  if (current._count.payments > 0 || current.status === 'PAID') throw new ConflictError('An obligation with payments cannot be deleted.');
  await withAudit(auditContext(ctx, orgId), async (tx) => {
    await tx.taxObligation.delete({ where: { id } });
    await audit(tx, ctx, 'TAX_OBLIGATION_UPDATED', 'TAX_OBLIGATION', id, current.period, `Deleted tax obligation for ${current.period}`);
  });
}

export async function fileTaxObligation(ctx: RequestContext, id: string) {
  const orgId = await access(ctx, 'EDIT');
  const current = await prisma.taxObligation.findFirst({ where: { id, organizationId: orgId } });
  if (!current) throw new NotFoundError('Tax obligation', id);
  if (current.status === 'NOT_APPLICABLE' || current.status === 'EXEMPT' || current.status === 'PAID') {
    throw new ConflictError(`A ${current.status.toLowerCase()} obligation cannot be filed.`);
  }
  return withAudit(auditContext(ctx, orgId), async (tx) => {
    const row = await tx.taxObligation.update({ where: { id }, data: { status: 'FILED', filedAt: new Date() } });
    await audit(tx, ctx, 'TAX_OBLIGATION_FILED', 'TAX_OBLIGATION', id, row.period, `Filed tax obligation for ${row.period}`);
    return row;
  });
}

export async function markTaxObligationPaid(ctx: RequestContext, id: string) {
  const orgId = await access(ctx, 'EDIT');
  const current = await prisma.taxObligation.findFirst({ where: { id, organizationId: orgId }, include: { payments: true } });
  if (!current) throw new NotFoundError('Tax obligation', id);
  if (current.status === 'NOT_APPLICABLE' || current.status === 'EXEMPT') throw new ConflictError('This obligation does not have a payable amount.');
  const paid = current.payments.reduce((sum, payment) => sum.plus(payment.amount), new Prisma.Decimal(0));
  if (paid.lessThan(current.taxAmount)) throw new ConflictError('Recorded payments do not cover the obligation amount.');
  return withAudit(auditContext(ctx, orgId), async (tx) => {
    const row = await tx.taxObligation.update({ where: { id }, data: { status: 'PAID' } });
    await audit(tx, ctx, 'TAX_OBLIGATION_PAID', 'TAX_OBLIGATION', id, row.period, `Marked tax obligation for ${row.period} paid`, { totalPaid: paid.toString() });
    return row;
  });
}

export async function listTaxPayments(ctx: RequestContext) {
  const orgId = await access(ctx, 'VIEW');
  return prisma.taxPayment.findMany({
    where: { organizationId: orgId },
    include: { obligation: { select: { id: true, period: true, status: true, taxRule: { select: { code: true, name: true } } } }, document: { select: { id: true, title: true } } },
    orderBy: { paidAt: 'desc' },
  });
}

export async function getTaxPayment(ctx: RequestContext, id: string) {
  const orgId = await access(ctx, 'VIEW');
  const row = await prisma.taxPayment.findFirst({
    where: { id, organizationId: orgId },
    include: { obligation: true, document: true, journalEntry: true },
  });
  if (!row) throw new NotFoundError('Tax payment', id);
  return row;
}

export async function createTaxPayment(ctx: RequestContext, input: TaxPaymentCreateInput) {
  const orgId = await access(ctx, 'CREATE');
  const obligation = await prisma.taxObligation.findFirst({ where: { id: input.obligationId, organizationId: orgId } });
  if (!obligation) throw new NotFoundError('Tax obligation', input.obligationId);
  if (obligation.status === 'NOT_APPLICABLE' || obligation.status === 'EXEMPT') {
    throw new ConflictError('Payments cannot be recorded against an obligation with no payable amount.');
  }
  const amount = new Prisma.Decimal(input.amount);
  if (!amount.isPositive() || input.currencyCode !== obligation.currencyCode) {
    throw new ValidationError('Payment amount must be positive and use the obligation currency.');
  }
  await validateDocument(orgId, input.documentId);
  if (input.journalEntryId) {
    const journalEntry = await prisma.journalEntry.findFirst({ where: { id: input.journalEntryId, organizationId: orgId } });
    if (!journalEntry) throw new NotFoundError('Journal entry', input.journalEntryId);
  }
  return withAudit(auditContext(ctx, orgId), async (tx) => {
    const row = await tx.taxPayment.create({
      data: {
        organizationId: orgId,
        obligationId: obligation.id,
        paidAt: toDate(input.paidAt)!,
        amount,
        currencyCode: input.currencyCode,
        reference: input.reference ?? null,
        documentId: input.documentId ?? null,
        journalEntryId: input.journalEntryId ?? null,
        createdById: ctx.actor.userId,
      },
    });
    const payments = await tx.taxPayment.aggregate({ where: { obligationId: obligation.id }, _sum: { amount: true } });
    const totalPaid = payments._sum.amount ?? new Prisma.Decimal(0);
    const nextStatus = totalPaid.greaterThanOrEqualTo(obligation.taxAmount) ? 'PAID' : obligation.status === 'FILED' ? 'FILED' : 'PENDING';
    await tx.taxObligation.update({ where: { id: obligation.id }, data: { status: nextStatus } });
    await audit(tx, ctx, 'TAX_PAYMENT_CREATED', 'TAX_PAYMENT', row.id, row.reference ?? row.id, 'Recorded a tax payment', {
      obligationId: obligation.id, amount: row.amount.toString(), currencyCode: row.currencyCode,
    });
    if (nextStatus === 'PAID') {
      await audit(tx, ctx, 'TAX_OBLIGATION_PAID', 'TAX_OBLIGATION', obligation.id, obligation.period, `Marked tax obligation for ${obligation.period} paid`, { totalPaid: totalPaid.toString() });
    }
    return row;
  });
}

export async function updateTaxPayment(ctx: RequestContext, id: string, input: TaxPaymentUpdateInput) {
  const orgId = await access(ctx, 'EDIT');
  const current = await prisma.taxPayment.findFirst({ where: { id, organizationId: orgId } });
  if (!current) throw new NotFoundError('Tax payment', id);
  const obligation = await prisma.taxObligation.findFirst({ where: { id: current.obligationId, organizationId: orgId } });
  if (!obligation) throw new NotFoundError('Tax obligation', current.obligationId);
  if (input.currencyCode && input.currencyCode !== obligation.currencyCode) throw new ValidationError('Payment currency must match the obligation currency.');
  if (input.amount && !new Prisma.Decimal(input.amount).isPositive()) throw new ValidationError('Payment amount must be positive.');
  if (input.documentId !== undefined) await validateDocument(orgId, input.documentId);
  return withAudit(auditContext(ctx, orgId), async (tx) => {
    const row = await tx.taxPayment.update({
      where: { id },
      data: {
        ...(input.paidAt !== undefined ? { paidAt: toDate(input.paidAt)! } : {}),
        ...(input.amount !== undefined ? { amount: new Prisma.Decimal(input.amount) } : {}),
        ...(input.currencyCode !== undefined ? { currencyCode: input.currencyCode } : {}),
        ...(input.reference !== undefined ? { reference: input.reference } : {}),
        ...(input.documentId !== undefined ? { documentId: input.documentId } : {}),
        ...(input.journalEntryId !== undefined ? { journalEntryId: input.journalEntryId } : {}),
      },
    });
    await refreshObligationPaidStatus(tx, obligation.id);
    await audit(tx, ctx, 'TAX_PAYMENT_UPDATED', 'TAX_PAYMENT', row.id, row.reference ?? row.id, 'Updated a tax payment');
    return row;
  });
}

export async function deleteTaxPayment(ctx: RequestContext, id: string) {
  const orgId = await access(ctx, 'ADMINISTER');
  const current = await prisma.taxPayment.findFirst({ where: { id, organizationId: orgId } });
  if (!current) throw new NotFoundError('Tax payment', id);
  return withAudit(auditContext(ctx, orgId), async (tx) => {
    await tx.taxPayment.delete({ where: { id } });
    await refreshObligationPaidStatus(tx, current.obligationId);
    await audit(tx, ctx, 'TAX_PAYMENT_DELETED', 'TAX_PAYMENT', id, current.reference ?? id, 'Deleted a tax payment');
  });
}

async function refreshObligationPaidStatus(tx: Prisma.TransactionClient, obligationId: string) {
  const obligation = await tx.taxObligation.findUniqueOrThrow({ where: { id: obligationId } });
  const aggregate = await tx.taxPayment.aggregate({ where: { obligationId }, _sum: { amount: true } });
  const paid = aggregate._sum.amount ?? new Prisma.Decimal(0);
  if (obligation.status === 'NOT_APPLICABLE' || obligation.status === 'EXEMPT') return;
  const status = paid.greaterThanOrEqualTo(obligation.taxAmount)
    ? 'PAID'
    : obligation.filedAt
      ? 'FILED'
      : obligation.status === 'OVERDUE'
        ? 'OVERDUE'
        : 'PENDING';
  await tx.taxObligation.update({ where: { id: obligationId }, data: { status } });
}

async function validateDocument(orgId: string, documentId?: string | null) {
  if (!documentId) return;
  const document = await prisma.document.findFirst({ where: { id: documentId, organizationId: orgId, deletedAt: null } });
  if (!document) throw new NotFoundError('Document', documentId);
}

export async function listCredentials(ctx: RequestContext, filters: { status?: string; type?: string } = {}) {
  const orgId = await access(ctx, 'VIEW');
  return prisma.credential.findMany({
    where: {
      organizationId: orgId,
      ...(filters.status ? { status: filters.status as Prisma.EnumCredentialStatusFilter['equals'] } : {}),
      ...(filters.type ? { type: filters.type as Prisma.EnumCredentialTypeFilter['equals'] } : {}),
    },
    include: { responsibleUser: { select: { id: true, fullName: true, email: true } }, document: { select: { id: true, title: true, expiryDate: true } } },
    orderBy: [{ expiryDate: 'asc' }, { title: 'asc' }],
  });
}

export async function getCredential(ctx: RequestContext, id: string) {
  const orgId = await access(ctx, 'VIEW');
  const row = await prisma.credential.findFirst({
    where: { id, organizationId: orgId },
    include: { responsibleUser: { select: { id: true, fullName: true, email: true } }, document: true, complianceDocuments: { include: { document: true } } },
  });
  if (!row) throw new NotFoundError('Credential', id);
  return row;
}

export async function createCredential(ctx: RequestContext, input: CredentialCreateInput) {
  const orgId = await access(ctx, 'CREATE');
  await validateCredentialRelations(orgId, input.responsibleUserId, input.documentId);
  const organization = await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { registrationStatus: true } });
  let status = input.status ?? 'ACTIVE';
  if (organization.registrationStatus !== 'REGISTERED' && input.type === 'REGISTRATION') status = 'NOT_APPLICABLE';
  return withAudit(auditContext(ctx, orgId), async (tx) => {
    const row = await tx.credential.create({
      data: {
        organizationId: orgId,
        type: input.type,
        title: input.title,
        issuingAuthority: input.issuingAuthority ?? null,
        registrationNumber: input.registrationNumber ?? null,
        issuedDate: toDate(input.issuedDate) ?? null,
        expiryDate: toDate(input.expiryDate) ?? null,
        responsibleUserId: input.responsibleUserId,
        cost: toDecimal(input.cost) ?? null,
        currencyCode: input.currencyCode ?? null,
        status,
        renewalReminderDays: input.renewalReminderDays,
        documentId: input.documentId ?? null,
        notes: input.notes ?? null,
        createdById: ctx.actor.userId,
      },
    });
    await audit(tx, ctx, 'CREDENTIAL_CREATED', 'CREDENTIAL', row.id, row.title, `Created compliance credential ${row.title}`, { type: row.type, status: row.status });
    return row;
  });
}

export async function updateCredential(ctx: RequestContext, id: string, input: CredentialUpdateInput) {
  const orgId = await access(ctx, 'EDIT');
  const current = await prisma.credential.findFirst({ where: { id, organizationId: orgId } });
  if (!current) throw new NotFoundError('Credential', id);
  await validateCredentialRelations(orgId, input.responsibleUserId ?? current.responsibleUserId, input.documentId === undefined ? current.documentId : input.documentId);
  return withAudit(auditContext(ctx, orgId), async (tx) => {
    const row = await tx.credential.update({
      where: { id },
      data: {
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.issuingAuthority !== undefined ? { issuingAuthority: input.issuingAuthority } : {}),
        ...(input.registrationNumber !== undefined ? { registrationNumber: input.registrationNumber } : {}),
        ...(input.issuedDate !== undefined ? { issuedDate: toDate(input.issuedDate) } : {}),
        ...(input.expiryDate !== undefined ? { expiryDate: toDate(input.expiryDate) } : {}),
        ...(input.responsibleUserId !== undefined ? { responsibleUserId: input.responsibleUserId } : {}),
        ...(input.cost !== undefined ? { cost: toDecimal(input.cost) } : {}),
        ...(input.currencyCode !== undefined ? { currencyCode: input.currencyCode } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.renewalReminderDays !== undefined ? { renewalReminderDays: input.renewalReminderDays } : {}),
        ...(input.documentId !== undefined ? { documentId: input.documentId } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
    });
    await audit(tx, ctx, 'CREDENTIAL_UPDATED', 'CREDENTIAL', row.id, row.title, `Updated compliance credential ${row.title}`, { status: row.status });
    return row;
  });
}

async function validateCredentialRelations(orgId: string, userId: string, documentId?: string | null) {
  const membership = await prisma.organizationMembership.findFirst({ where: { organizationId: orgId, userId }, select: { organizationId: true } });
  if (!membership) throw new ValidationError('The responsible user must belong to the active organization.');
  await validateDocument(orgId, documentId);
}

export async function deleteCredential(ctx: RequestContext, id: string) {
  const orgId = await access(ctx, 'ADMINISTER');
  const current = await prisma.credential.findFirst({ where: { id, organizationId: orgId } });
  if (!current) throw new NotFoundError('Credential', id);
  await withAudit(auditContext(ctx, orgId), async (tx) => {
    await tx.credential.delete({ where: { id } });
    await audit(tx, ctx, 'CREDENTIAL_DELETED', 'CREDENTIAL', id, current.title, `Deleted compliance credential ${current.title}`);
  });
}

export async function listComplianceDocuments(ctx: RequestContext) {
  const orgId = await access(ctx, 'VIEW');
  return prisma.complianceDocument.findMany({
    where: { organizationId: orgId },
    include: { document: true, credential: true, obligation: { include: { taxRule: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createComplianceDocument(ctx: RequestContext, input: ComplianceDocumentCreateInput) {
  const orgId = await access(ctx, 'CREATE');
  const [document, credential, obligation] = await Promise.all([
    prisma.document.findFirst({ where: { id: input.documentId, organizationId: orgId, deletedAt: null }, select: { id: true } }),
    input.credentialId ? prisma.credential.findFirst({ where: { id: input.credentialId, organizationId: orgId }, select: { id: true } }) : Promise.resolve(null),
    input.obligationId ? prisma.taxObligation.findFirst({ where: { id: input.obligationId, organizationId: orgId }, select: { id: true } }) : Promise.resolve(null),
  ]);
  if (!document) throw new NotFoundError('Document', input.documentId);
  if (input.credentialId && !credential) throw new NotFoundError('Credential', input.credentialId);
  if (input.obligationId && !obligation) throw new NotFoundError('Tax obligation', input.obligationId);
  return withAudit(auditContext(ctx, orgId), async (tx) => {
    const row = await tx.complianceDocument.create({
      data: {
        organizationId: orgId,
        documentId: input.documentId,
        credentialId: input.credentialId ?? null,
        obligationId: input.obligationId ?? null,
        notes: input.notes ?? null,
        createdById: ctx.actor.userId,
      },
    });
    await audit(tx, ctx, 'COMPLIANCE_DOCUMENT_LINKED', 'COMPLIANCE_DOCUMENT', row.id, row.documentId, 'Linked a compliance document', {
      credentialId: row.credentialId, obligationId: row.obligationId,
    });
    return row;
  });
}

export async function deleteComplianceDocument(ctx: RequestContext, id: string) {
  const orgId = await access(ctx, 'EDIT');
  const current = await prisma.complianceDocument.findFirst({ where: { id, organizationId: orgId } });
  if (!current) throw new NotFoundError('Compliance document link', id);
  await withAudit(auditContext(ctx, orgId), async (tx) => {
    await tx.complianceDocument.delete({ where: { id } });
    await audit(tx, ctx, 'COMPLIANCE_DOCUMENT_UNLINKED', 'COMPLIANCE_DOCUMENT', id, current.documentId, 'Unlinked a compliance document');
  });
}

export async function getComplianceStatus(ctx: RequestContext) {
  const orgId = await access(ctx, 'VIEW');
  const now = new Date();
  const [organization, unverifiedRules, obligations, credentials, expiringDocuments] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { registrationStatus: true } }),
    prisma.taxRule.findMany({ where: { organizationId: orgId, isActive: true, isVerified: false }, select: { id: true, code: true, name: true, type: true, jurisdiction: true } }),
    prisma.taxObligation.findMany({
      where: { organizationId: orgId, status: { in: ['PENDING', 'FILED', 'OVERDUE'] } },
      include: { taxRule: { select: { id: true, code: true, name: true } } },
      orderBy: { filingDueDate: 'asc' },
    }),
    prisma.credential.findMany({
      where: { organizationId: orgId, status: { notIn: ['REVOKED', 'NOT_APPLICABLE'] } },
      include: { responsibleUser: { select: { id: true, fullName: true } } },
      orderBy: { expiryDate: 'asc' },
    }),
    prisma.document.findMany({
      where: { organizationId: orgId, deletedAt: null, expiryDate: { lte: new Date(now.getTime() + 90 * 86_400_000) } },
      select: { id: true, title: true, category: true, expiryDate: true, renewalDueAt: true },
      orderBy: { expiryDate: 'asc' },
    }),
  ]);
  const dueObligations = obligations.map((obligation) => ({
    ...obligation,
    status: obligation.status !== 'PAID' && obligation.filingDueDate && obligation.filingDueDate < now ? 'OVERDUE' as const : obligation.status,
  }));
  const expiringCredentials = credentials.filter((credential) => {
    if (!credential.expiryDate) return false;
    return credential.expiryDate.getTime() <= now.getTime() + credential.renewalReminderDays * 86_400_000;
  });
  return {
    registrationStatus: organization.registrationStatus,
    warnings: unverifiedRules.map((rule) => ({
      code: 'UNVERIFIED_TAX_RULE',
      message: `Tax rule ${rule.code} has not been professionally verified.`,
      rule,
    })),
    obligations: dueObligations,
    expiringCredentials,
    expiringDocuments,
    counts: {
      unverifiedRules: unverifiedRules.length,
      overdueObligations: dueObligations.filter((row) => row.status === 'OVERDUE').length,
      expiringCredentials: expiringCredentials.length,
      expiringDocuments: expiringDocuments.length,
    },
  };
}

export async function getTaxReport(ctx: RequestContext, filters: { period?: string } = {}) {
  const orgId = await access(ctx, 'VIEW');
  const rows = await prisma.taxObligation.findMany({
    where: { organizationId: orgId, ...(filters.period ? { period: filters.period } : {}) },
    include: { taxRule: { select: { id: true, code: true, name: true, type: true, jurisdiction: true } }, payments: { select: { amount: true, paidAt: true } } },
    orderBy: [{ period: 'desc' }, { createdAt: 'desc' }],
  });
  const summary = new Map<string, {
    ruleId: string | null; ruleCode: string; ruleName: string; period: string; currencyCode: string;
    taxableAmount: Prisma.Decimal; taxAmount: Prisma.Decimal; paidAmount: Prisma.Decimal; obligationCount: number;
  }>();
  for (const row of rows) {
    const key = `${row.taxRuleId ?? 'unassigned'}:${row.period}:${row.currencyCode}`;
    const item = summary.get(key) ?? {
      ruleId: row.taxRuleId,
      ruleCode: row.taxRule?.code ?? 'UNASSIGNED',
      ruleName: row.taxRule?.name ?? 'Unassigned obligation',
      period: row.period,
      currencyCode: row.currencyCode,
      taxableAmount: new Prisma.Decimal(0),
      taxAmount: new Prisma.Decimal(0),
      paidAmount: new Prisma.Decimal(0),
      obligationCount: 0,
    };
    item.taxableAmount = item.taxableAmount.plus(row.taxableAmount);
    item.taxAmount = item.taxAmount.plus(row.taxAmount);
    item.paidAmount = item.paidAmount.plus(row.payments.reduce((sum, payment) => sum.plus(payment.amount), new Prisma.Decimal(0)));
    item.obligationCount += 1;
    summary.set(key, item);
  }
  return { rows, summary: [...summary.values()] };
}

export async function getComplianceReport(ctx: RequestContext) {
  const orgId = await access(ctx, 'VIEW');
  const now = new Date();
  const [credentials, documents, obligations, unverifiedRules] = await Promise.all([
    prisma.credential.findMany({
      where: { organizationId: orgId, status: { notIn: ['REVOKED', 'NOT_APPLICABLE'] } },
      include: { responsibleUser: { select: { id: true, fullName: true } }, document: { select: { id: true, title: true, expiryDate: true } } },
      orderBy: { expiryDate: 'asc' },
    }),
    prisma.document.findMany({
      where: { organizationId: orgId, deletedAt: null, expiryDate: { not: null } },
      select: { id: true, title: true, category: true, expiryDate: true, renewalDueAt: true },
      orderBy: { expiryDate: 'asc' },
    }),
    prisma.taxObligation.findMany({
      where: { organizationId: orgId, status: { in: ['PENDING', 'FILED', 'OVERDUE'] } },
      include: { taxRule: { select: { id: true, code: true, name: true } } },
      orderBy: { filingDueDate: 'asc' },
    }),
    prisma.taxRule.findMany({ where: { organizationId: orgId, isActive: true, isVerified: false }, select: { id: true, code: true, name: true, jurisdiction: true } }),
  ]);
  return {
    credentials: credentials.map((row) => ({ ...row, derivedStatus: credentialStatus(row.expiryDate, row.status, row.renewalReminderDays, now) })),
    documents: documents.filter((row) => row.expiryDate && row.expiryDate.getTime() <= now.getTime() + 90 * 86_400_000),
    obligations: obligations.map((row) => ({
      ...row,
      derivedStatus: row.status !== 'PAID' && row.filingDueDate && row.filingDueDate < now ? 'OVERDUE' as const : row.status,
    })),
    unverifiedRules,
  };
}

function credentialStatus(expiryDate: Date | null, status: CredentialStatus, reminderDays: number, now: Date): CredentialStatus {
  if (status === 'REVOKED' || status === 'NOT_APPLICABLE') return status;
  if (!expiryDate) return status;
  if (expiryDate < now) return 'EXPIRED';
  if (expiryDate.getTime() <= now.getTime() + reminderDays * 86_400_000) return 'EXPIRING_SOON';
  return status === 'EXPIRING_SOON' || status === 'EXPIRED' ? 'ACTIVE' : status;
}

export interface ComplianceMaintenanceResult {
  remindersCreated: number;
  credentialsUpdated: number;
}

/** Scheduled reminder path follows the idempotent M12 document-expiry pattern. */
export async function runComplianceMaintenance(now = new Date()): Promise<ComplianceMaintenanceResult> {
  const result: ComplianceMaintenanceResult = { remindersCreated: 0, credentialsUpdated: 0 };
  const credentials = await prisma.credential.findMany({
    where: { status: { notIn: ['REVOKED', 'NOT_APPLICABLE'] } },
    select: { id: true, organizationId: true, title: true, type: true, status: true, expiryDate: true, renewalReminderDays: true, responsibleUserId: true },
  });
  for (const credential of credentials) {
    const status = credentialStatus(credential.expiryDate, credential.status, credential.renewalReminderDays, now);
    if (status !== credential.status) {
      await withAudit({
        organizationId: credential.organizationId,
        actor: { id: null, name: 'Compliance reminder job', roleCodes: ['SYSTEM'] },
      }, async (tx) => {
        await tx.credential.update({ where: { id: credential.id }, data: { status } });
        await writeAuditEntry(tx, { id: null, name: 'Compliance reminder job', roleCodes: ['SYSTEM'] }, {
          action: 'CREDENTIAL_UPDATED',
          entityType: 'CREDENTIAL',
          entityId: credential.id,
          entityLabel: credential.title,
          description: `Credential status changed to ${status}`,
          changes: { status: { from: credential.status, to: status } },
        }, { organizationId: credential.organizationId });
      });
      result.credentialsUpdated += 1;
    }
    if (!credential.expiryDate) continue;
    const daysToExpiry = Math.ceil((credential.expiryDate.getTime() - now.getTime()) / 86_400_000);
    if (daysToExpiry > credential.renewalReminderDays) continue;
    const expiryDate = credential.expiryDate.toISOString().slice(0, 10);
    const created = await prisma.notification.createMany({
      data: [{
        organizationId: credential.organizationId,
        userId: credential.responsibleUserId,
        category: 'COMPLIANCE_EXPIRY',
        severity: daysToExpiry < 0 ? 'CRITICAL' : 'WARNING',
        channel: 'IN_APP',
        status: 'PENDING',
        title: daysToExpiry < 0 ? 'Credential has expired' : 'Credential renewal is due',
        body: `${credential.title} expires on ${expiryDate}. Review it and record a renewal if needed.`,
        actionUrl: '/tax-compliance/credentials',
        dedupeKey: `credential-expiry:${credential.id}:${expiryDate}`,
      }],
      skipDuplicates: true,
    });
    result.remindersCreated += created.count;
  }
  return result;
}

export async function issueTaxInvoice(ctx: RequestContext, invoiceId: string) {
  const orgId = await access(ctx, 'EDIT');
  const invoice = await prisma.invoice.findFirst({ where: { id: invoiceId, organizationId: orgId } });
  if (!invoice) throw new NotFoundError('Invoice', invoiceId);
  if (invoice.taxInvoiceNumber) throw new ConflictError('A tax invoice number has already been issued.');

  const rules = await prisma.taxRule.findMany({
    where: {
      organizationId: orgId,
      isActive: true,
      effectiveFrom: { lte: invoice.invoiceDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: invoice.invoiceDate } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  });
  const selected = new Map<string, typeof rules[number]>();
  for (const rule of rules) {
    const key = `${rule.type}:${rule.jurisdiction}`;
    if (!selected.has(key)) selected.set(key, rule);
  }
  const effectiveRules = [...selected.values()];
  if (effectiveRules.length === 0) throw new ValidationError('Configure at least one effective tax rule before issuing a tax invoice.');

  const organization = await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { registrationStatus: true } });
  const applied = effectiveRules.map((rule) => {
    const calculation = calculateTax(invoice.subtotal, rule, invoice.invoiceDate, {
      organizationRegistered: organization.registrationStatus === 'REGISTERED',
    });
    return {
      ruleId: rule.id,
      code: rule.code,
      type: rule.type,
      jurisdiction: rule.jurisdiction,
      isVerified: rule.isVerified,
      applicability: calculation.applicability,
      taxableAmount: calculation.taxableAmount.toString(),
      taxAmount: calculation.taxAmount.toString(),
    };
  });
  const taxAmount = applied.reduce((sum, item) => sum.plus(item.taxAmount), new Prisma.Decimal(0));
  const totalAmount = invoice.subtotal.plus(taxAmount);
  return withAudit(auditContext(ctx, orgId), async (tx) => {
    const sequence = await tx.taxInvoiceSequence.upsert({
      where: { organizationId: orgId },
      create: { organizationId: orgId, nextNumber: 2 },
      update: { nextNumber: { increment: 1 } },
    });
    const allocatedNumber = sequence.nextNumber - 1;
    const number = `${sequence.prefix}${String(allocatedNumber).padStart(sequence.padding, '0')}${sequence.suffix}`;
    const row = await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        taxInvoiceNumber: number,
        isTaxInvoice: true,
        taxInvoiceValid: true,
        taxRulesApplied: applied satisfies Prisma.InputJsonObject[],
        taxAmount,
        totalAmount,
      },
    });
    await audit(tx, ctx, 'TAX_INVOICE_ISSUED', 'TAX_INVOICE', row.id, number, `Issued tax invoice ${number}`, {
      invoiceId: row.id,
      ruleIds: effectiveRules.map((rule) => rule.id),
      containsUnverifiedRules: effectiveRules.some((rule) => !rule.isVerified),
    });
    return row;
  });
}

export async function calculateConfiguredTax(
  ctx: RequestContext,
  input: { amount: string | number; ruleType: string; jurisdiction?: string; documentDate: string },
) {
  const orgId = await access(ctx, 'VIEW');
  const date = new Date(input.documentDate);
  if (Number.isNaN(date.getTime())) throw new ValidationError('Document date must be valid.');
  const organization = await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { registrationStatus: true } });
  const rules = await prisma.taxRule.findMany({ where: { organizationId: orgId, type: input.ruleType as never, ...(input.jurisdiction ? { jurisdiction: input.jurisdiction } : {}) } });
  const rule = selectEffectiveTaxRule(rules, date);
  if (!rule) throw new NotFoundError('Effective tax rule');
  const result = calculateTax(input.amount, rule, date, { organizationRegistered: organization.registrationStatus === 'REGISTERED' });
  return { rule, result };
}
