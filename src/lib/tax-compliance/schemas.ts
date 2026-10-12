import { z } from 'zod';

const dateSchema = z.string().trim().min(1).refine((value) => !Number.isNaN(Date.parse(value)), 'Enter a valid date.');
const decimalSchema = z.union([z.string().trim(), z.number()]).transform(String).refine(
  (value) => /^-?\d+(\.\d+)?$/.test(value),
  'Enter a valid decimal amount.',
);

const taxRuleFieldsSchema = z.object({
  code: z.string().trim().min(1).max(50).toUpperCase(),
  name: z.string().trim().min(1).max(160),
  type: z.enum(['VAT', 'WITHHOLDING', 'INCOME_TAX', 'TURNOVER_TAX', 'FILING_FEE', 'STAMP_DUTY', 'OTHER']),
  jurisdiction: z.string().trim().min(1).max(160),
  ratePercent: decimalSchema.nullable().optional(),
  isInclusive: z.boolean().default(false),
  calculationBasis: z.enum(['EXCLUSIVE', 'INCLUSIVE', 'NOT_APPLICABLE']),
  appliesWhenOrganizationRegistered: z.boolean().default(true),
  effectiveFrom: dateSchema,
  effectiveTo: dateSchema.nullable().optional(),
  isActive: z.boolean().default(true),
  payableAccountId: z.string().cuid().nullable().optional(),
  receivableAccountId: z.string().cuid().nullable().optional(),
  roundingMode: z.enum(['HALF_UP', 'HALF_DOWN', 'HALF_EVEN', 'UP', 'DOWN']).default('HALF_UP'),
  minTaxableAmount: decimalSchema.nullable().optional(),
  exemptionThreshold: decimalSchema.nullable().optional(),
  verifiedByProfessionalOn: dateSchema.nullable().optional(),
  verifiedByProfessionalName: z.string().trim().max(160).nullable().optional(),
  verificationReference: z.string().trim().max(160).nullable().optional(),
  isVerified: z.boolean().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
});

export const taxRuleCreateSchema = taxRuleFieldsSchema.superRefine((value, context) => {
  if (value.calculationBasis !== 'NOT_APPLICABLE' && value.ratePercent === null) {
    context.addIssue({ code: 'custom', path: ['ratePercent'], message: 'Configure a rate for an applicable rule.' });
  }
  if (value.isInclusive !== (value.calculationBasis === 'INCLUSIVE')) {
    context.addIssue({ code: 'custom', path: ['isInclusive'], message: 'Inclusive flag and calculation basis must agree.' });
  }
  if (value.effectiveTo && Date.parse(value.effectiveTo) < Date.parse(value.effectiveFrom)) {
    context.addIssue({ code: 'custom', path: ['effectiveTo'], message: 'End date must be on or after the start date.' });
  }
});

export const taxRuleUpdateSchema = taxRuleFieldsSchema.partial();

export const taxObligationCreateSchema = z.object({
  taxRuleId: z.string().cuid().nullable().optional(),
  period: z.string().trim().min(1).max(40),
  direction: z.enum(['OUTPUT', 'INPUT', 'WITHHELD', 'PAYABLE']),
  status: z.enum(['PENDING', 'FILED', 'PAID', 'OVERDUE', 'EXEMPT', 'NOT_APPLICABLE']).optional(),
  filingDueDate: dateSchema.nullable().optional(),
  filedAt: dateSchema.nullable().optional(),
  taxableAmount: decimalSchema,
  taxAmount: decimalSchema,
  currencyCode: z.string().trim().length(3).toUpperCase(),
  description: z.string().trim().max(4000).nullable().optional(),
});

export const taxObligationUpdateSchema = taxObligationCreateSchema.partial();

export const taxPaymentCreateSchema = z.object({
  obligationId: z.string().cuid(),
  paidAt: dateSchema,
  amount: decimalSchema,
  currencyCode: z.string().trim().length(3).toUpperCase(),
  reference: z.string().trim().max(160).nullable().optional(),
  documentId: z.string().cuid().nullable().optional(),
  journalEntryId: z.string().cuid().nullable().optional(),
});

export const taxPaymentUpdateSchema = taxPaymentCreateSchema.partial().omit({ obligationId: true });

export const credentialCreateSchema = z.object({
  type: z.enum(['REGISTRATION', 'TIN_CERTIFICATE', 'LICENCE', 'PERMIT', 'CERTIFICATION', 'MEMBERSHIP', 'DOMAIN', 'INSURANCE', 'SOFTWARE_SUBSCRIPTION', 'OTHER']),
  title: z.string().trim().min(1).max(200),
  issuingAuthority: z.string().trim().max(200).nullable().optional(),
  registrationNumber: z.string().trim().max(160).nullable().optional(),
  issuedDate: dateSchema.nullable().optional(),
  expiryDate: dateSchema.nullable().optional(),
  responsibleUserId: z.string().cuid(),
  cost: decimalSchema.nullable().optional(),
  currencyCode: z.string().trim().length(3).toUpperCase().nullable().optional(),
  status: z.enum(['PENDING', 'ACTIVE', 'EXPIRING_SOON', 'EXPIRED', 'REVOKED', 'NOT_APPLICABLE']).optional(),
  renewalReminderDays: z.number().int().nonnegative().max(3650).default(30),
  documentId: z.string().cuid().nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
});

export const credentialUpdateSchema = credentialCreateSchema.partial();

export const complianceDocumentCreateSchema = z.object({
  documentId: z.string().cuid(),
  credentialId: z.string().cuid().nullable().optional(),
  obligationId: z.string().cuid().nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
}).refine((value) => Boolean(value.credentialId) !== Boolean(value.obligationId), {
  message: 'Link the document to exactly one credential or obligation.',
});

export type TaxRuleCreateInput = z.infer<typeof taxRuleCreateSchema>;
export type TaxRuleUpdateInput = z.infer<typeof taxRuleUpdateSchema>;
export type TaxObligationCreateInput = z.infer<typeof taxObligationCreateSchema>;
export type TaxObligationUpdateInput = z.infer<typeof taxObligationUpdateSchema>;
export type TaxPaymentCreateInput = z.infer<typeof taxPaymentCreateSchema>;
export type TaxPaymentUpdateInput = z.infer<typeof taxPaymentUpdateSchema>;
export type CredentialCreateInput = z.infer<typeof credentialCreateSchema>;
export type CredentialUpdateInput = z.infer<typeof credentialUpdateSchema>;
export type ComplianceDocumentCreateInput = z.infer<typeof complianceDocumentCreateSchema>;
