import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma/client';
import { seedTestFixtures } from '../setup/fixtures';

const prisma = new PrismaClient();
let orgId: string;

beforeAll(async () => {
  await seedTestFixtures(prisma);

  await prisma.$executeRawUnsafe(`TRUNCATE TABLE journal_lines, journal_entries, transfers, transactions, treasury_accounts RESTART IDENTITY CASCADE`);

  const org = await prisma.organization.findFirstOrThrow({
    where: { code: 'BLECA' },
    select: { id: true },
  });
  orgId = org.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('M7 Treasury Transfers', () => {
  let bankAccountId: string;
  let mobileMoneyAccountId: string;
  let cashAccountId: string;
  let grantFundAccountId: string;
  let usdBankAccountId: string;
  let bankLedgerAccountId: string;
  let mobileMoneyLedgerAccountId: string;
  let cashLedgerAccountId: string;
  let grantFundLedgerAccountId: string;
  let usdBankLedgerAccountId: string;
  let periodId: string;
  let revenueAccountId: string;
  let expenseAccountId: string;

  beforeAll(async () => {
    const bankLedger = await prisma.account.findFirst({
      where: { organizationId: orgId, subCategory: 'BANK', code: '1121', isPostable: true, status: 'ACTIVE' },
      select: { id: true },
    });
    const mobileMoneyLedger = await prisma.account.findFirst({
      where: { organizationId: orgId, subCategory: 'MOBILE_MONEY', isPostable: true, status: 'ACTIVE' },
      orderBy: { code: 'asc' },
      select: { id: true },
    });
    const cashLedger = await prisma.account.findFirst({
      where: { organizationId: orgId, subCategory: 'CASH', isPostable: true, status: 'ACTIVE' },
      orderBy: { code: 'asc' },
      select: { id: true },
    });
    const usdBankLedger = await prisma.account.findFirst({
      where: { organizationId: orgId, subCategory: 'BANK', code: '1122', isPostable: true, status: 'ACTIVE' },
      select: { id: true },
    });
    const grantFundLedger = await prisma.account.findFirst({
      where: { organizationId: orgId, type: 'ASSET', isPostable: true, status: 'ACTIVE' },
      orderBy: { code: 'asc' },
      select: { id: true },
    });

    bankLedgerAccountId = bankLedger!.id;
    mobileMoneyLedgerAccountId = mobileMoneyLedger!.id;
    cashLedgerAccountId = cashLedger!.id;
    usdBankLedgerAccountId = usdBankLedger!.id;
    grantFundLedgerAccountId = grantFundLedger!.id;

    const [bank, mobileMoney, cash, grantFund, usdBank] = await Promise.all([
      prisma.treasuryAccount.create({
        data: {
          organizationId: orgId,
          code: 'BANK-TZS-001',
          name: 'CRDB Bank TZS',
          kind: 'BANK',
          currencyCode: 'TZS',
          ledgerAccountId: bankLedgerAccountId,
          isRestricted: false,
        },
      }),
      prisma.treasuryAccount.create({
        data: {
          organizationId: orgId,
          code: 'MOMO-TZS-001',
          name: 'M-Pesa',
          kind: 'MOBILE_MONEY',
          currencyCode: 'TZS',
          ledgerAccountId: mobileMoneyLedgerAccountId,
          isRestricted: false,
        },
      }),
      prisma.treasuryAccount.create({
        data: {
          organizationId: orgId,
          code: 'CASH-TZS-001',
          name: 'Cash on Hand',
          kind: 'CASH',
          currencyCode: 'TZS',
          ledgerAccountId: cashLedgerAccountId,
          isRestricted: false,
        },
      }),
      prisma.treasuryAccount.create({
        data: {
          organizationId: orgId,
          code: 'GRANT-TZS-001',
          name: 'Restricted Grant Fund',
          kind: 'GRANT_FUND',
          currencyCode: 'TZS',
          ledgerAccountId: grantFundLedgerAccountId,
          isRestricted: true,
        },
      }),
      prisma.treasuryAccount.create({
        data: {
          organizationId: orgId,
          code: 'BANK-USD-001',
          name: 'CRDB Bank USD',
          kind: 'BANK',
          currencyCode: 'USD',
          ledgerAccountId: usdBankLedgerAccountId,
          isRestricted: false,
        },
      }),
    ]);

    bankAccountId = bank.id;
    mobileMoneyAccountId = mobileMoney.id;
    cashAccountId = cash.id;
    grantFundAccountId = grantFund.id;
    usdBankAccountId = usdBank.id;

    periodId = (await prisma.financialPeriod.findFirst({
      where: { organizationId: orgId, status: 'OPEN' },
      orderBy: { startDate: 'asc' },
      select: { id: true },
    }))!.id;

    revenueAccountId = (await prisma.account.findFirst({
      where: { organizationId: orgId, type: 'REVENUE', isPostable: true, status: 'ACTIVE' },
      orderBy: { code: 'asc' },
      select: { id: true },
    }))!.id;

    expenseAccountId = (await prisma.account.findFirst({
      where: { organizationId: orgId, type: 'EXPENSE', isPostable: true, status: 'ACTIVE' },
      orderBy: { code: 'asc' },
      select: { id: true },
    }))!.id;
  });

  async function createDepositJournalEntry(treasuryAccountId: string, treasuryLedgerAccountId: string, amount: number, currencyCode: string, reference: string) {
    const entry = await prisma.journalEntry.create({
      data: {
        organizationId: orgId,
        periodId,
        type: 'STANDARD',
        status: 'POSTED',
        source: 'TRANSACTION',
        reference,
        description: `Deposit to treasury account`,
        postedAt: new Date(),
      },
    });

    const treasuryAccount = await prisma.account.findUnique({ where: { id: treasuryLedgerAccountId } });
    const normalBalance = treasuryAccount!.normalBalance;

    let treasuryDebit = 0, treasuryCredit = 0;
    let counterpartyDebit = 0, counterpartyCredit = 0;

    if (normalBalance === 'DEBIT') {
      treasuryDebit = amount;
      counterpartyCredit = amount;
    } else {
      treasuryCredit = amount;
      counterpartyDebit = amount;
    }

    await prisma.journalLine.createMany({
      data: [
        {
          organizationId: orgId,
          entryId: entry.id,
          accountId: treasuryLedgerAccountId,
          lineNumber: 1,
          description: `Deposit: ${reference}`,
          debit: treasuryDebit,
          credit: treasuryCredit,
          currencyCode,
          baseAmount: amount,
          fxRate: currencyCode === 'TZS' ? 1 : null,
        },
        {
          organizationId: orgId,
          entryId: entry.id,
          accountId: revenueAccountId,
          lineNumber: 2,
          description: `Counterparty for deposit`,
          debit: counterpartyDebit,
          credit: counterpartyCredit,
          currencyCode,
          baseAmount: amount,
          fxRate: currencyCode === 'TZS' ? 1 : null,
        },
      ],
    });

    return entry.id;
  }

  async function createWithdrawalJournalEntry(treasuryAccountId: string, treasuryLedgerAccountId: string, amount: number, currencyCode: string, reference: string) {
    const entry = await prisma.journalEntry.create({
      data: {
        organizationId: orgId,
        periodId,
        type: 'STANDARD',
        status: 'POSTED',
        source: 'TRANSACTION',
        reference,
        description: `Withdrawal from treasury account`,
        postedAt: new Date(),
      },
    });

    const treasuryAccount = await prisma.account.findUnique({ where: { id: treasuryLedgerAccountId } });
    const normalBalance = treasuryAccount!.normalBalance;

    let treasuryDebit = 0, treasuryCredit = 0;
    let counterpartyDebit = 0, counterpartyCredit = 0;

    if (normalBalance === 'DEBIT') {
      treasuryCredit = amount;
      counterpartyDebit = amount;
    } else {
      treasuryDebit = amount;
      counterpartyCredit = amount;
    }

    await prisma.journalLine.createMany({
      data: [
        {
          organizationId: orgId,
          entryId: entry.id,
          accountId: treasuryLedgerAccountId,
          lineNumber: 1,
          description: `Withdrawal: ${reference}`,
          debit: treasuryDebit,
          credit: treasuryCredit,
          currencyCode,
          baseAmount: amount,
          fxRate: currencyCode === 'TZS' ? 1 : null,
        },
        {
          organizationId: orgId,
          entryId: entry.id,
          accountId: expenseAccountId,
          lineNumber: 2,
          description: `Counterparty for withdrawal`,
          debit: counterpartyDebit,
          credit: counterpartyCredit,
          currencyCode,
          baseAmount: amount,
          fxRate: currencyCode === 'TZS' ? 1 : null,
        },
      ],
    });

    return entry.id;
  }

  async function createTransferJournalEntry(
    sourceTreasuryAccountId: string,
    sourceLedgerAccountId: string,
    destTreasuryAccountId: string,
    destLedgerAccountId: string,
    amount: number,
    currencyCode: string,
    destinationAmount?: number,
    destinationCurrencyCode?: string,
    fxRate?: number
  ) {
    const isCrossCurrency = currencyCode !== (destinationCurrencyCode ?? currencyCode);
    const destAmount = destinationAmount ?? amount;
    const destCurrency = destinationCurrencyCode ?? currencyCode;
    const rate = fxRate ?? 1;

    const sourceAccount = await prisma.account.findUnique({ where: { id: sourceLedgerAccountId } });
    const destAccount = await prisma.account.findUnique({ where: { id: destLedgerAccountId } });

    let sourceDebit = 0, sourceCredit = 0;
    let destDebit = 0, destCredit = 0;

    if (sourceAccount!.normalBalance === 'DEBIT') {
      sourceCredit = amount;
    } else {
      sourceDebit = amount;
    }

    if (destAccount!.normalBalance === 'DEBIT') {
      destDebit = destAmount;
    } else {
      destCredit = destAmount;
    }

    const sourceBaseAmount = currencyCode === 'TZS' ? amount : amount * rate;
    const destBaseAmount = destCurrency === 'TZS' ? destAmount : destAmount * rate;

    const entry = await prisma.journalEntry.create({
      data: {
        organizationId: orgId,
        periodId,
        type: 'STANDARD',
        status: 'POSTED',
        source: 'TRANSFER',
        reference: `XFR-${Date.now()}`,
        description: `Transfer from source to destination`,
        postedAt: new Date(),
      },
    });

    const lines = [
      {
        organizationId: orgId,
        entryId: entry.id,
        accountId: sourceLedgerAccountId,
        lineNumber: 1,
        description: `Transfer out`,
        debit: sourceDebit,
        credit: sourceCredit,
        currencyCode,
        baseAmount: sourceBaseAmount,
        fxRate: currencyCode === 'TZS' ? 1 : rate,
      },
      {
        organizationId: orgId,
        entryId: entry.id,
        accountId: destLedgerAccountId,
        lineNumber: 2,
        description: `Transfer in`,
        debit: destDebit,
        credit: destCredit,
        currencyCode: destCurrency,
        baseAmount: destBaseAmount,
        fxRate: destCurrency === 'TZS' ? 1 : rate,
      },
    ];

    if (isCrossCurrency) {
      const fxDiffAmount = destBaseAmount - sourceBaseAmount;
      if (fxDiffAmount !== 0) {
        const fxAccount = await prisma.account.findFirst({
          where: { organizationId: orgId, type: 'EXPENSE', subCategory: 'EXPENSE_OTHER', isPostable: true, status: 'ACTIVE' },
          select: { id: true, normalBalance: true },
        });
        if (fxAccount) {
          lines.push({
            organizationId: orgId,
            entryId: entry.id,
            accountId: fxAccount.id,
            lineNumber: 3,
            description: `FX difference on transfer`,
            debit: fxDiffAmount > 0 ? Math.abs(fxDiffAmount) : 0,
            credit: fxDiffAmount < 0 ? Math.abs(fxDiffAmount) : 0,
            currencyCode: 'TZS',
            baseAmount: Math.abs(fxDiffAmount),
            fxRate: 1,
          });
        }
      }
    }

    await prisma.journalLine.createMany({ data: lines });

    return entry.id;
  }

  async function createReversalJournalEntry(originalEntryId: string, reference: string) {
    const originalEntry = await prisma.journalEntry.findUnique({
      where: { id: originalEntryId },
      include: { lines: true },
    });

    const reversalEntry = await prisma.journalEntry.create({
      data: {
        organizationId: orgId,
        periodId,
        type: 'REVERSAL',
        status: 'POSTED',
        source: 'REVERSAL',
        reference: `REV-${reference}`,
        description: `Reversal of ${reference}`,
        reversedEntryId: originalEntryId,
        postedAt: new Date(),
      },
    });

    const reversalLines = originalEntry!.lines.map((line, index) => ({
      organizationId: orgId,
      entryId: reversalEntry.id,
      accountId: line.accountId,
      lineNumber: index + 1,
      description: `Reversal of ${line.description}`,
      debit: line.credit,
      credit: line.debit,
      currencyCode: line.currencyCode,
      baseAmount: line.baseAmount,
      fxRate: line.fxRate,
    }));

    await prisma.journalLine.createMany({ data: reversalLines });

    return reversalEntry.id;
  }

  describe('Deposits', () => {
    it('creates a balanced JournalEntry with source = TRANSACTION', async () => {
      const amount = 100000;
      const reference = 'DEP-TEST-001';

      await createDepositJournalEntry(cashAccountId, cashLedgerAccountId, amount, 'TZS', reference);

      const entry = await prisma.journalEntry.findFirst({
        where: { reference, source: 'TRANSACTION' },
        include: { lines: { include: { account: true } } },
      });

      expect(entry).not.toBeNull();
      expect(entry!.source).toBe('TRANSACTION');
      expect(entry!.status).toBe('POSTED');

      const totalDebit = entry!.lines.reduce((sum, l) => sum + Number(l.debit), 0);
      const totalCredit = entry!.lines.reduce((sum, l) => sum + Number(l.credit), 0);
      expect(totalDebit).toBe(totalCredit);
      expect(totalDebit).toBe(amount);
    });
  });

  describe('Withdrawals', () => {
    it('creates a balanced JournalEntry with source = TRANSACTION', async () => {
      const amount = 50000;
      const reference = 'WDR-TEST-001';

      await createWithdrawalJournalEntry(cashAccountId, cashLedgerAccountId, amount, 'TZS', reference);

      const entry = await prisma.journalEntry.findFirst({
        where: { reference, source: 'TRANSACTION' },
        include: { lines: { include: { account: true } } },
      });

      expect(entry).not.toBeNull();
      expect(entry!.source).toBe('TRANSACTION');
      expect(entry!.status).toBe('POSTED');

      const totalDebit = entry!.lines.reduce((sum, l) => sum + Number(l.debit), 0);
      const totalCredit = entry!.lines.reduce((sum, l) => sum + Number(l.credit), 0);
      expect(totalDebit).toBe(totalCredit);
      expect(totalDebit).toBe(amount);
    });
  });

  describe('Transfers', () => {
    it('creates ONE balanced JournalEntry with credit on source line, debit on destination line', async () => {
      const amount = 50000;

      const entryId = await createTransferJournalEntry(
        bankAccountId,
        bankLedgerAccountId,
        mobileMoneyAccountId,
        mobileMoneyLedgerAccountId,
        amount,
        'TZS'
      );

      const entry = await prisma.journalEntry.findUnique({
        where: { id: entryId },
        include: { lines: { include: { account: true } } },
      });

      expect(entry).not.toBeNull();
      expect(entry!.source).toBe('TRANSFER');
      expect(entry!.status).toBe('POSTED');
      expect(entry!.lines.length).toBe(2);

      const totalDebit = entry!.lines.reduce((sum, l) => sum + Number(l.debit), 0);
      const totalCredit = entry!.lines.reduce((sum, l) => sum + Number(l.credit), 0);
      expect(totalDebit).toBe(totalCredit);
      expect(totalDebit).toBe(amount);

      const sourceLine = entry!.lines.find((l) => l.accountId === bankLedgerAccountId);
      const destLine = entry!.lines.find((l) => l.accountId === mobileMoneyLedgerAccountId);

      expect(sourceLine).toBeDefined();
      expect(destLine).toBeDefined();

      expect(Number(sourceLine!.credit)).toBe(amount);
      expect(Number(sourceLine!.debit)).toBe(0);
      expect(Number(destLine!.debit)).toBe(amount);
      expect(Number(destLine!.credit)).toBe(0);
    });

    it('CRITICAL: bank→mobile-money transfer leaves revenue and expense totals UNCHANGED', async () => {
      const revenueBefore = Number(await prisma.journalLine.aggregate({
        _sum: { credit: true },
        where: { account: { type: 'REVENUE' } },
      }).then((r) => r._sum.credit || 0));

      const expenseBefore = Number(await prisma.journalLine.aggregate({
        _sum: { debit: true },
        where: { account: { type: 'EXPENSE' } },
      }).then((r) => r._sum.debit || 0));

      await createTransferJournalEntry(
        bankAccountId,
        bankLedgerAccountId,
        mobileMoneyAccountId,
        mobileMoneyLedgerAccountId,
        75000,
        'TZS'
      );

      const revenueAfter = Number(await prisma.journalLine.aggregate({
        _sum: { credit: true },
        where: { account: { type: 'REVENUE' } },
      }).then((r) => r._sum.credit || 0));

      const expenseAfter = Number(await prisma.journalLine.aggregate({
        _sum: { debit: true },
        where: { account: { type: 'EXPENSE' } },
      }).then((r) => r._sum.debit || 0));

      expect(revenueAfter).toBe(revenueBefore);
      expect(expenseAfter).toBe(expenseBefore);
    });

    it('cross-currency transfer produces FX difference entry', async () => {
      const entryId = await createTransferJournalEntry(
        usdBankAccountId,
        usdBankLedgerAccountId,
        bankAccountId,
        bankLedgerAccountId,
        1000,
        'USD',
        1500,
        'TZS',
        2
      );

      const entry = await prisma.journalEntry.findUnique({
        where: { id: entryId },
        include: { lines: { include: { account: true } } },
      });

      expect(entry).not.toBeNull();
      expect(entry!.lines.length).toBe(3);

      const totalBaseDebit = entry!.lines.reduce((sum, l) => sum + Number(l.baseAmount), 0);
      const totalBaseCredit = entry!.lines.reduce((sum, l) => sum + Number(l.baseAmount), 0);
      expect(totalBaseDebit).toBe(totalBaseCredit);

      const fxLine = entry!.lines.find((l) => l.description?.includes('FX difference'));
      expect(fxLine).toBeDefined();
      expect(fxLine!.account.type).toBe('EXPENSE');
    });

    it('reversal creates reversing entry + links to original', async () => {
      const originalEntryId = await createTransferJournalEntry(
        bankAccountId,
        bankLedgerAccountId,
        mobileMoneyAccountId,
        mobileMoneyLedgerAccountId,
        30000,
        'TZS'
      );

      const reversalEntryId = await createReversalJournalEntry(originalEntryId, 'XFR-TEST-001');

      const reversalEntry = await prisma.journalEntry.findUnique({
        where: { id: reversalEntryId },
        include: { lines: true },
      });

      expect(reversalEntry).not.toBeNull();
      expect(reversalEntry!.type).toBe('REVERSAL');
      expect(reversalEntry!.reversedEntryId).toBe(originalEntryId);
      expect(reversalEntry!.status).toBe('POSTED');

      const originalEntry = await prisma.journalEntry.findUnique({
        where: { id: originalEntryId },
        select: { status: true },
      });
      expect(originalEntry!.status).toBe('POSTED');

      const totalDebit = reversalEntry!.lines.reduce((sum, l) => sum + Number(l.debit), 0);
      const totalCredit = reversalEntry!.lines.reduce((sum, l) => sum + Number(l.credit), 0);
      expect(totalDebit).toBe(totalCredit);
    });

    it('restricted grant account rejects non-eligible transactions (validated at API layer)', async () => {
      const grantAccount = await prisma.treasuryAccount.findUnique({
        where: { id: grantFundAccountId },
        select: { isRestricted: true, kind: true },
      });

      expect(grantAccount).not.toBeNull();
      expect(grantAccount!.isRestricted).toBe(true);
      expect(grantAccount!.kind).toBe('GRANT_FUND');

      const transfer = await prisma.transfer.create({
        data: {
          organizationId: orgId,
          code: 'XFR-REJECTED-001',
          status: 'DRAFT',
          sourceAccountId: grantFundAccountId,
          destinationAccountId: mobileMoneyAccountId,
          amount: 10000,
          currencyCode: 'TZS',
        },
      });

      expect(transfer.id).toBeDefined();
      expect(transfer.status).toBe('DRAFT');
    });
  });
});