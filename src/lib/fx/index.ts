import { PrismaClient } from '@/generated/prisma/client';

const prisma = new PrismaClient();

export interface FxConversionOptions {
  roundingMode?: 'HALF_UP' | 'HALF_DOWN' | 'HALF_EVEN' | 'UP' | 'DOWN';
  precision?: number;
  differenceTreatment?: 'EXPENSE' | 'INCOME' | 'SUSPENSE';
}

export interface FxRateResult {
  rate: bigint;
  rateDate: Date;
  baseCurrency: string;
  quoteCurrency: string;
  differenceTreatment: 'EXPENSE' | 'INCOME' | 'SUSPENSE';
}

export interface FxConversionResult {
  convertedAmount: bigint;
  rate: bigint;
  fxDifference: bigint;
  differenceAccount: 'EXPENSE' | 'INCOME' | 'SUSPENSE';
  rateDate: Date;
  baseCurrency: string;
  quoteCurrency: string;
}

function roundAmount(amount: bigint, precision: number, mode: 'HALF_UP' | 'HALF_DOWN' | 'HALF_EVEN' | 'UP' | 'DOWN'): bigint {
  const factor = 10n ** BigInt(precision);
  const scaled = amount * factor;
  const remainder = scaled % 10n;
  const base = scaled / 10n;

  switch (mode) {
    case 'HALF_UP':
      return remainder >= 5n ? base + 1n : base;
    case 'HALF_DOWN':
      return remainder > 5n ? base + 1n : base;
    case 'HALF_EVEN':
      if (remainder > 5n) return base + 1n;
      if (remainder < 5n) return base;
      return base % 2n === 0n ? base : base + 1n;
    case 'UP':
      return remainder > 0n ? base + 1n : base;
    case 'DOWN':
      return base;
  }
}

export async function getExchangeRate(
  baseCurrencyCode: string,
  quoteCurrencyCode: string,
  rateDate: Date,
  options: { requireExactDate?: boolean } = {}
): Promise<FxRateResult> {
  const baseCurrency = await prisma.currency.findUniqueOrThrow({
    where: { code: baseCurrencyCode },
    select: { id: true, code: true },
  });

  const quoteCurrency = await prisma.currency.findUniqueOrThrow({
    where: { code: quoteCurrencyCode },
    select: { id: true, code: true },
  });

  let rateRecord;

  if (options.requireExactDate) {
    rateRecord = await prisma.exchangeRate.findFirst({
      where: {
        baseCurrencyId: baseCurrency.id,
        quoteCurrencyId: quoteCurrency.id,
        rateDate: {
          gte: new Date(rateDate.getFullYear(), rateDate.getMonth(), rateDate.getDate()),
          lt: new Date(rateDate.getFullYear(), rateDate.getMonth(), rateDate.getDate() + 1),
        },
      },
      orderBy: { rateDate: 'desc' },
      select: {
        rate: true,
        rateDate: true,
        differenceTreatment: true,
        baseCurrencyId: true,
        quoteCurrencyId: true,
      },
    });
  } else {
    rateRecord = await prisma.exchangeRate.findFirst({
      where: {
        baseCurrencyId: baseCurrency.id,
        quoteCurrencyId: quoteCurrency.id,
        rateDate: { lte: rateDate },
      },
      orderBy: { rateDate: 'desc' },
      select: {
        rate: true,
        rateDate: true,
        differenceTreatment: true,
        baseCurrencyId: true,
        quoteCurrencyId: true,
      },
    });
  }

  if (!rateRecord) {
    throw new Error(
      `No exchange rate found for ${baseCurrencyCode}/${quoteCurrencyCode} on or before ${rateDate.toISOString().split('T')[0]}`
    );
  }

  const rateStr = rateRecord.rate.toString();
    const [intPart, fracPart = ''] = rateStr.split('.');
    const fracPadded = (fracPart + '0'.repeat(10)).slice(0, 10);
    const rate = BigInt(intPart + fracPadded);

    return {
      rate,
      rateDate: rateRecord.rateDate,
      baseCurrency: baseCurrencyCode,
      quoteCurrency: quoteCurrencyCode,
      differenceTreatment: rateRecord.differenceTreatment,
    };
}

export async function convertCurrency(
  amount: bigint,
  fromCurrencyCode: string,
  toCurrencyCode: string,
  rateDate: Date,
  options: FxConversionOptions = {}
): Promise<FxConversionResult> {
  const { roundingMode = 'HALF_UP', precision: _precision = 2, differenceTreatment = 'EXPENSE' } = options;

  if (fromCurrencyCode === toCurrencyCode) {
    return {
      convertedAmount: amount,
      rate: 1_0000000000n,
      fxDifference: 0n,
      differenceAccount: differenceTreatment,
      rateDate,
      baseCurrency: fromCurrencyCode,
      quoteCurrency: toCurrencyCode,
    };
  }

  const fxRate = await getExchangeRate(fromCurrencyCode, toCurrencyCode, rateDate);

  const SCALE = 1_0000000000n;

  // Proper integer rounding: (numerator + denominator/2) / denominator for HALF_UP
  // For other modes, apply appropriate adjustment
  const numerator = amount * fxRate.rate;
  let convertedAmount: bigint;

  switch (roundingMode) {
    case 'HALF_UP':
      convertedAmount = (numerator + SCALE / 2n) / SCALE;
      break;
    case 'HALF_DOWN':
      convertedAmount = (numerator + SCALE / 2n - 1n) / SCALE;
      break;
    case 'HALF_EVEN':
      // Banker's rounding: round to nearest, ties to even
      const quotient = numerator / SCALE;
      const remainder = numerator % SCALE;
      const half = SCALE / 2n;
      if (remainder > half) {
        convertedAmount = quotient + 1n;
      } else if (remainder < half) {
        convertedAmount = quotient;
      } else {
        // Exactly half - round to even
        convertedAmount = (quotient % 2n === 0n) ? quotient : quotient + 1n;
      }
      break;
    case 'UP':
      convertedAmount = (numerator + SCALE - 1n) / SCALE;
      break;
    case 'DOWN':
      convertedAmount = numerator / SCALE;
      break;
    default:
      convertedAmount = (numerator + SCALE / 2n) / SCALE;
  }

  const expectedRaw = (amount * fxRate.rate) / SCALE;
  const fxDifference = convertedAmount - expectedRaw;

  return {
    convertedAmount,
    rate: fxRate.rate,
    fxDifference,
    differenceAccount: fxRate.differenceTreatment as 'EXPENSE' | 'INCOME' | 'SUSPENSE',
    rateDate: fxRate.rateDate,
    baseCurrency: fxRate.baseCurrency,
    quoteCurrency: fxRate.quoteCurrency,
  };
}

export async function convertCurrencyWithFallback(
  amount: bigint,
  fromCurrencyCode: string,
  toCurrencyCode: string,
  rateDate: Date,
  options: FxConversionOptions = {}
): Promise<FxConversionResult> {
  try {
    return await convertCurrency(amount, fromCurrencyCode, toCurrencyCode, rateDate, options);
  } catch (error) {
    if (error instanceof Error && error.message.includes('No exchange rate found')) {
      const inverse = await convertCurrency(amount, toCurrencyCode, fromCurrencyCode, rateDate, options);
      const invertedRate = 1_0000000000n * 1_0000000000n / inverse.rate;
      const convertedAmount = roundAmount(
        (amount * invertedRate) / 1_0000000000n,
        options.precision ?? 2,
        options.roundingMode ?? 'HALF_UP'
      );
      const expectedRaw = (amount * invertedRate) / 1_0000000000n;
      const fxDifference = convertedAmount - expectedRaw;

      return {
        convertedAmount,
        rate: invertedRate,
        fxDifference,
        differenceAccount: options.differenceTreatment ?? 'EXPENSE',
        rateDate: inverse.rateDate,
        baseCurrency: fromCurrencyCode,
        quoteCurrency: toCurrencyCode,
      };
    }
    throw error;
  }
}

export function formatAmount(amount: bigint, currencyCode: string, decimals: number = 2): string {
  const divisor = 10n ** BigInt(decimals);
  const integerPart = amount / divisor;
  const fractionalPart = amount % divisor;
  const fractionalStr = fractionalPart.toString().padStart(decimals, '0');
  return `${integerPart}.${fractionalStr}`;
}

export function parseAmount(amountStr: string, decimals: number = 2): bigint {
  const parts = amountStr.split('.');
  const integerPart = parts[0] || '0';
  const fractionalPart = parts[1] ?? '';
  const fractional = (fractionalPart + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(integerPart) * 10n ** BigInt(decimals) + BigInt(fractional);
}