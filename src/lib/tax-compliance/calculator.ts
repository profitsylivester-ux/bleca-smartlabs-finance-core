import { Prisma, type TaxRule } from '@/generated/prisma/client';
import { ValidationError } from '@/lib/kernel/errors';

const MONEY_SCALE = 6;
const HUNDRED = new Prisma.Decimal(100);

export interface TaxCalculationResult {
  taxableAmount: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  total: Prisma.Decimal;
  applicability: 'APPLICABLE' | 'NOT_APPLICABLE';
}

export interface TaxCalculationContext {
  organizationRegistered?: boolean;
}

type CalculatorRule = Pick<
  TaxRule,
  | 'ratePercent'
  | 'isInclusive'
  | 'calculationBasis'
  | 'appliesWhenOrganizationRegistered'
  | 'effectiveFrom'
  | 'effectiveTo'
  | 'isActive'
  | 'roundingMode'
  | 'minTaxableAmount'
  | 'exemptionThreshold'
>;

function round(value: Prisma.Decimal, mode: TaxRule['roundingMode']): Prisma.Decimal {
  const rounding = {
    HALF_UP: Prisma.Decimal.ROUND_HALF_UP,
    HALF_DOWN: Prisma.Decimal.ROUND_HALF_DOWN,
    HALF_EVEN: Prisma.Decimal.ROUND_HALF_EVEN,
    UP: Prisma.Decimal.ROUND_UP,
    DOWN: Prisma.Decimal.ROUND_DOWN,
  }[mode];
  return value.toDecimalPlaces(MONEY_SCALE, rounding);
}

function dateOnly(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function notApplicable(total: Prisma.Decimal): TaxCalculationResult {
  return {
    taxableAmount: new Prisma.Decimal(0),
    taxAmount: new Prisma.Decimal(0),
    total,
    applicability: 'NOT_APPLICABLE',
  };
}

/** Calculates solely from the supplied, date-effective configuration row. */
export function calculateTax(
  amount: Prisma.Decimal.Value,
  taxRule: CalculatorRule,
  documentDate: Date,
  context: TaxCalculationContext = {},
): TaxCalculationResult {
  const input = new Prisma.Decimal(amount);
  if (!input.isFinite() || input.isNegative()) {
    throw new ValidationError('Taxable amount must be a finite, non-negative value.');
  }
  if (Number.isNaN(documentDate.getTime())) {
    throw new ValidationError('Document date must be valid.');
  }

  const total = round(input, taxRule.roundingMode);
  const ruleIsEffective =
    dateOnly(documentDate) >= dateOnly(taxRule.effectiveFrom) &&
    (taxRule.effectiveTo === null || dateOnly(documentDate) <= dateOnly(taxRule.effectiveTo));

  if (!taxRule.isActive || !ruleIsEffective || taxRule.calculationBasis === 'NOT_APPLICABLE') {
    return notApplicable(total);
  }
  if (taxRule.appliesWhenOrganizationRegistered && context.organizationRegistered === false) {
    return notApplicable(total);
  }
  if (taxRule.ratePercent === null) {
    throw new ValidationError('An applicable tax rule must have a configured rate.');
  }
  if (taxRule.isInclusive !== (taxRule.calculationBasis === 'INCLUSIVE')) {
    throw new ValidationError('Tax rule inclusive flag and calculation basis must agree.');
  }

  const rate = taxRule.ratePercent.dividedBy(HUNDRED);
  const minimum = taxRule.minTaxableAmount ?? new Prisma.Decimal(0);
  const exemption = taxRule.exemptionThreshold ?? new Prisma.Decimal(0);
  if (input.lessThan(minimum)) {
    return {
      taxableAmount: new Prisma.Decimal(0),
      taxAmount: new Prisma.Decimal(0),
      total,
      applicability: 'APPLICABLE',
    };
  }

  if (taxRule.isInclusive) {
    // Solve gross = base + max(base - exemption, 0) * rate.
    if (input.lessThanOrEqualTo(exemption)) {
      return {
        taxableAmount: new Prisma.Decimal(0),
        taxAmount: new Prisma.Decimal(0),
        total,
        applicability: 'APPLICABLE',
      };
    }
    const baseAmount = input.plus(exemption.times(rate)).dividedBy(new Prisma.Decimal(1).plus(rate));
    const taxableAmount = round(baseAmount.minus(exemption), taxRule.roundingMode);
    const taxAmount = round(taxableAmount.times(rate), taxRule.roundingMode);
    return { taxableAmount, taxAmount, total, applicability: 'APPLICABLE' };
  }

  const taxableAmount = round(Prisma.Decimal.max(input.minus(exemption), 0), taxRule.roundingMode);
  const taxAmount = round(taxableAmount.times(rate), taxRule.roundingMode);
  return {
    taxableAmount,
    taxAmount,
    total: round(input.plus(taxAmount), taxRule.roundingMode),
    applicability: 'APPLICABLE',
  };
}

export function selectEffectiveTaxRule<T extends Pick<TaxRule, 'isActive' | 'effectiveFrom' | 'effectiveTo'>>(
  rules: T[],
  documentDate: Date,
): T | null {
  const date = dateOnly(documentDate);
  return (
    rules
      .filter(
        (rule) =>
          rule.isActive &&
          dateOnly(rule.effectiveFrom) <= date &&
          (rule.effectiveTo === null || dateOnly(rule.effectiveTo) >= date),
      )
      .sort((left, right) => dateOnly(right.effectiveFrom) - dateOnly(left.effectiveFrom))[0] ?? null
  );
}
