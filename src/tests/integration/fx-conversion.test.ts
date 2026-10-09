import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db/prisma';
import { seedTestFixtures } from '../setup/fixtures';
import { convertCurrency, getExchangeRate } from '@/lib/fx';

let testDateCounter = 0;
function nextTestDate(): Date {
  const base = new Date('2025-01-01');
  base.setDate(base.getDate() + testDateCounter++);
  return base;
}

beforeAll(async () => {
  await seedTestFixtures(prisma);
});

describe('FX Library - Historical Conversion', () => {
  it('fetches the correct rate for a historical date', async () => {
    const tzs = await prisma.currency.findUniqueOrThrow({ where: { code: 'TZS' } });
    const usd = await prisma.currency.findUniqueOrThrow({ where: { code: 'USD' } });

    const date = nextTestDate();
    await prisma.exchangeRate.create({
      data: {
        baseCurrencyId: tzs.id,
        quoteCurrencyId: usd.id,
        rateDate: date,
        rate: '0.00038', // 1 USD = 2631.58 TZS
        source: 'BOT',
        differenceTreatment: 'EXPENSE',
      },
    });

    const rate = await getExchangeRate('TZS', 'USD', date);
    expect(rate.baseCurrency).toBe('TZS');
    expect(rate.quoteCurrency).toBe('USD');
    // rate is stored as Decimal(20,10), converted to integer with 10 decimal places
    expect(rate.rate).toBe(3800000n); // 0.00038 * 10^10 = 3,800,000
    expect(rate.differenceTreatment).toBe('EXPENSE');
  });

  it('finds the most recent rate on or before the transaction date', async () => {
    const tzs = await prisma.currency.findUniqueOrThrow({ where: { code: 'TZS' } });
    const eur = await prisma.currency.findUniqueOrThrow({ where: { code: 'EUR' } });

    const date1 = nextTestDate();
    const date2 = nextTestDate();
    await prisma.exchangeRate.createMany({
      data: [
        {
          baseCurrencyId: tzs.id,
          quoteCurrencyId: eur.id,
          rateDate: date1,
          rate: '0.00035',
          source: 'BOT',
          differenceTreatment: 'EXPENSE',
        },
        {
          baseCurrencyId: tzs.id,
          quoteCurrencyId: eur.id,
          rateDate: date2,
          rate: '0.00036',
          source: 'BOT',
          differenceTreatment: 'EXPENSE',
        },
      ],
    });

    // Transaction between date1 and date2 should use date1 rate
    const midDate = new Date(date1.getTime() + (date2.getTime() - date1.getTime()) / 2);
    const rate = await getExchangeRate('TZS', 'EUR', midDate);
    expect(rate.rate).toBe(3500000n); // 0.00035 * 10^10
    expect(rate.rateDate.toISOString().split('T')[0]).toBe(date1.toISOString().split('T')[0]);
  });

  it('throws explicit error when no rate exists for the date', async () => {
    const tzs = await prisma.currency.findUniqueOrThrow({ where: { code: 'TZS' } });
    const gbp = await prisma.currency.findUniqueOrThrow({ where: { code: 'GBP' } });

    await expect(getExchangeRate('TZS', 'GBP', nextTestDate())).rejects.toThrow(
      'No exchange rate found for TZS/GBP on or before'
    );
  });

  it('converts TZS to USD with correct rounding (HALF_UP)', async () => {
    const tzs = await prisma.currency.findUniqueOrThrow({ where: { code: 'TZS' } });
    const usd = await prisma.currency.findUniqueOrThrow({ where: { code: 'USD' } });

    const date = nextTestDate();
    await prisma.exchangeRate.create({
      data: {
        baseCurrencyId: tzs.id,
        quoteCurrencyId: usd.id,
        rateDate: date,
        rate: '0.000384615', // 1 USD = 2600 TZS
        source: 'BOT',
        differenceTreatment: 'EXPENSE',
      },
    });

// 100,000 TZS = 38.4615 USD -> rounded to 3846 cents (HALF_UP, 2 decimals)
        const result = await convertCurrency(10_000_000n, 'TZS', 'USD', date);
        expect(result.convertedAmount).toBe(3846n); // 38.46 in cents
        expect(result.rate).toBe(3846150n); // 0.000384615 * 10^10 = 3,846,150
        expect(result.fxDifference).toBeLessThan(100n); // Difference in cents
  });

  it('applies FX difference treatment correctly (EXPENSE)', async () => {
    const tzs = await prisma.currency.findUniqueOrThrow({ where: { code: 'TZS' } });
    const usd = await prisma.currency.findUniqueOrThrow({ where: { code: 'USD' } });

    const date = nextTestDate();
    await prisma.exchangeRate.create({
      data: {
        baseCurrencyId: tzs.id,
        quoteCurrencyId: usd.id,
        rateDate: date,
        rate: '0.000384615',
        source: 'BOT',
        differenceTreatment: 'EXPENSE',
      },
    });

    const result = await convertCurrency(10_000_000n, 'TZS', 'USD', date);
    expect(result.differenceAccount).toBe('EXPENSE');
  });

  it('applies FX difference treatment correctly (INCOME)', async () => {
    const tzs = await prisma.currency.findUniqueOrThrow({ where: { code: 'TZS' } });
    const usd = await prisma.currency.findUniqueOrThrow({ where: { code: 'USD' } });

    const date = nextTestDate();
    await prisma.exchangeRate.create({
      data: {
        baseCurrencyId: tzs.id,
        quoteCurrencyId: usd.id,
        rateDate: date,
        rate: '0.000384615',
        source: 'BOT',
        differenceTreatment: 'INCOME',
      },
    });

    const result = await convertCurrency(10_000_000n, 'TZS', 'USD', date);
    expect(result.differenceAccount).toBe('INCOME');
  });

  it('applies FX difference treatment correctly (SUSPENSE)', async () => {
    const tzs = await prisma.currency.findUniqueOrThrow({ where: { code: 'TZS' } });
    const usd = await prisma.currency.findUniqueOrThrow({ where: { code: 'USD' } });

    const date = nextTestDate();
    await prisma.exchangeRate.create({
      data: {
        baseCurrencyId: tzs.id,
        quoteCurrencyId: usd.id,
        rateDate: date,
        rate: '0.000384615',
        source: 'BOT',
        differenceTreatment: 'SUSPENSE',
      },
    });

    const result = await convertCurrency(10_000_000n, 'TZS', 'USD', date);
    expect(result.differenceAccount).toBe('SUSPENSE');
  });

  it('converts same currency without rate lookup', async () => {
    const result = await convertCurrency(100_000_00n, 'TZS', 'TZS', nextTestDate());
    expect(result.convertedAmount).toBe(100_000_00n);
    expect(result.rate).toBe(1_0000000000n);
    expect(result.fxDifference).toBe(0n);
  });

  it('supports custom rounding modes', async () => {
    const tzs = await prisma.currency.findUniqueOrThrow({ where: { code: 'TZS' } });
    const usd = await prisma.currency.findUniqueOrThrow({ where: { code: 'USD' } });

    const date = nextTestDate();
    await prisma.exchangeRate.create({
      data: {
        baseCurrencyId: tzs.id,
        quoteCurrencyId: usd.id,
        rateDate: date,
        rate: '0.000384615',
        source: 'BOT',
        differenceTreatment: 'EXPENSE',
      },
    });

    // HALF_UP: 38.4615 -> 38.46
    const halfUp = await convertCurrency(10_000_000n, 'TZS', 'USD', date, { roundingMode: 'HALF_UP' });
    expect(halfUp.convertedAmount).toBe(3846n);

    // DOWN: 38.4615 -> 38.46
    const down = await convertCurrency(10_000_000n, 'TZS', 'USD', date, { roundingMode: 'DOWN' });
    expect(down.convertedAmount).toBe(3846n);

    // UP: 38.4615 -> 38.47
    const up = await convertCurrency(10_000_000n, 'TZS', 'USD', date, { roundingMode: 'UP' });
    expect(up.convertedAmount).toBe(3847n);
  });
});

describe('FX Library - Idempotent Rate Import', () => {
  it('rejects duplicate rate for same base/quote/date', async () => {
    const tzs = await prisma.currency.findUniqueOrThrow({ where: { code: 'TZS' } });
    const usd = await prisma.currency.findUniqueOrThrow({ where: { code: 'USD' } });

    const date = nextTestDate();
    await prisma.exchangeRate.create({
      data: {
        baseCurrencyId: tzs.id,
        quoteCurrencyId: usd.id,
        rateDate: date,
        rate: '0.00038',
        source: 'BOT',
        differenceTreatment: 'EXPENSE',
      },
    });

    await expect(
      prisma.exchangeRate.create({
        data: {
          baseCurrencyId: tzs.id,
          quoteCurrencyId: usd.id,
          rateDate: date,
          rate: '0.00039', // Different rate
          source: 'BOT',
          differenceTreatment: 'EXPENSE',
        },
      }),
    ).rejects.toThrow();
  });

  it('allows multiple rates for different dates', async () => {
    const tzs = await prisma.currency.findUniqueOrThrow({ where: { code: 'TZS' } });
    const usd = await prisma.currency.findUniqueOrThrow({ where: { code: 'USD' } });

    const date1 = nextTestDate();
    const date2 = nextTestDate();

    await prisma.exchangeRate.create({
      data: {
        baseCurrencyId: tzs.id,
        quoteCurrencyId: usd.id,
        rateDate: date1,
        rate: '0.00038',
        source: 'BOT',
        differenceTreatment: 'EXPENSE',
      },
    });

    await prisma.exchangeRate.create({
      data: {
        baseCurrencyId: tzs.id,
        quoteCurrencyId: usd.id,
        rateDate: date2,
        rate: '0.00039',
        source: 'BOT',
        differenceTreatment: 'EXPENSE',
      },
    });

    const rates = await prisma.exchangeRate.findMany({
      where: {
        baseCurrencyId: tzs.id,
        quoteCurrencyId: usd.id,
        rateDate: { in: [date1, date2] },
      },
      orderBy: { rateDate: 'asc' },
    });
    expect(rates).toHaveLength(2);
  });

  it('allows multiple rates for different currency pairs', async () => {
    const tzs = await prisma.currency.findUniqueOrThrow({ where: { code: 'TZS' } });
    const usd = await prisma.currency.findUniqueOrThrow({ where: { code: 'USD' } });
    const eur = await prisma.currency.findUniqueOrThrow({ where: { code: 'EUR' } });

    const date = nextTestDate();

    await prisma.exchangeRate.create({
      data: {
        baseCurrencyId: tzs.id,
        quoteCurrencyId: usd.id,
        rateDate: date,
        rate: '0.00038',
        source: 'BOT',
        differenceTreatment: 'EXPENSE',
      },
    });

    await prisma.exchangeRate.create({
      data: {
        baseCurrencyId: tzs.id,
        quoteCurrencyId: eur.id,
        rateDate: date,
        rate: '0.00035',
        source: 'BOT',
        differenceTreatment: 'EXPENSE',
      },
    });

    const rates = await prisma.exchangeRate.findMany({
      where: {
        baseCurrencyId: tzs.id,
        rateDate: date,
      },
    });
    expect(rates).toHaveLength(2);
  });

  it('conversion is reproducible across multiple calls', async () => {
    const tzs = await prisma.currency.findUniqueOrThrow({ where: { code: 'TZS' } });
    const usd = await prisma.currency.findUniqueOrThrow({ where: { code: 'USD' } });

    const date = nextTestDate();
    await prisma.exchangeRate.create({
      data: {
        baseCurrencyId: tzs.id,
        quoteCurrencyId: usd.id,
        rateDate: date,
        rate: '0.000384615384615',
        source: 'BOT',
        differenceTreatment: 'EXPENSE',
      },
    });

    const amount = 10_000_000n; // 100,000 TZS
    const results = await Promise.all([
      convertCurrency(amount, 'TZS', 'USD', date),
      convertCurrency(amount, 'TZS', 'USD', date),
      convertCurrency(amount, 'TZS', 'USD', date),
    ]);

    expect(results[0].convertedAmount).toBe(results[1].convertedAmount);
    expect(results[1].convertedAmount).toBe(results[2].convertedAmount);
    expect(results[0].rate).toBe(results[1].rate);
    expect(results[0].fxDifference).toBe(results[1].fxDifference);
  });

  it('rate lookup is deterministic for same inputs', async () => {
    const tzs = await prisma.currency.findUniqueOrThrow({ where: { code: 'TZS' } });
    const usd = await prisma.currency.findUniqueOrThrow({ where: { code: 'USD' } });

    const date = nextTestDate();
    await prisma.exchangeRate.create({
      data: {
        baseCurrencyId: tzs.id,
        quoteCurrencyId: usd.id,
        rateDate: date,
        rate: '0.000385',
        source: 'BOT',
        differenceTreatment: 'EXPENSE',
      },
    });

    const lookups = await Promise.all([
      getExchangeRate('TZS', 'USD', date),
      getExchangeRate('TZS', 'USD', date),
      getExchangeRate('TZS', 'USD', date),
    ]);

    expect(lookups[0].rate).toBe(lookups[1].rate);
    expect(lookups[1].rate).toBe(lookups[2].rate);
    expect(lookups[0].rateDate).toEqual(lookups[1].rateDate);
  });
});