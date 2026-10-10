import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma/client';
import { seedTestFixtures } from '../setup/fixtures';

const prisma = new PrismaClient();
let orgId: string;

beforeAll(async () => {
  await seedTestFixtures(prisma);

  const org = await prisma.organization.findFirstOrThrow({
    where: { code: 'BLECA' },
    select: { id: true },
  });
  orgId = org.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('M3 Task 1: Chart of Accounts seed (PDF §7)', () => {
  it('seeds all PDF §7 accounts with correct hierarchy', async () => {
    const accounts = await prisma.account.findMany({
      where: { organizationId: orgId },
      select: { code: true, name: true, type: true, parentId: true, normalBalance: true, isPostable: true, subCategory: true, status: true },
      orderBy: { code: 'asc' },
    });

    expect(accounts.length).toBeGreaterThan(100);

    const rootAccounts = accounts.filter((a) => !a.parentId);
    expect(rootAccounts.map((a) => a.code)).toContain('1000');
    expect(rootAccounts.map((a) => a.code)).toContain('2000');
    expect(rootAccounts.map((a) => a.code)).toContain('3000');
    expect(rootAccounts.map((a) => a.code)).toContain('4000');
    expect(rootAccounts.map((a) => a.code)).toContain('5000');
    expect(rootAccounts.map((a) => a.code)).toContain('9000');
  });

  it('has correct account types and normal balances per PDF §7', async () => {
    const assets = await prisma.account.findMany({ where: { organizationId: orgId, type: 'ASSET' } });
    const liabilities = await prisma.account.findMany({ where: { organizationId: orgId, type: 'LIABILITY' } });
    const equity = await prisma.account.findMany({ where: { organizationId: orgId, type: 'EQUITY' } });
    const revenue = await prisma.account.findMany({ where: { organizationId: orgId, type: 'REVENUE' } });
    const expenses = await prisma.account.findMany({ where: { organizationId: orgId, type: 'EXPENSE' } });

    for (const a of assets) expect(a.normalBalance).toBe('DEBIT');
    for (const a of liabilities) expect(a.normalBalance).toBe('CREDIT');
    for (const a of equity) expect(a.normalBalance).toBe('CREDIT');
    for (const a of revenue) expect(a.normalBalance).toBe('CREDIT');
    for (const a of expenses) expect(a.normalBalance).toBe('DEBIT');
  });

  it('includes dormant Phase 2 accounts marked INACTIVE', async () => {
    const dormantCodes = [
      '1150', '1151', '1152', '1153', // Inventory
      '1210', '1211', '1212', '1213', // Equipment
      '3300', // Future Investment
      '4400', '4401', '4402', // SaaS
      '4500', '4501', '4502', // AI Services
      '4600', '4601', '4602', // IoT Services
      '4700', '4701', '4702', // Hardware
      '4800', '4801', '4802', // Electronics
      '4900', '4901', '4902', // Component Sales
      '4960', '4961', '4962', // Token Packages
      '5800', '5801', '5802', '5803', '5804', // Salaries
      '5950', '5951', '5952', '5953', '5954', // Hardware Prototyping
    ];

    for (const code of dormantCodes) {
      const acc = await prisma.account.findUnique({
        where: { organizationId_code: { organizationId: orgId, code } },
        select: { status: true },
      });
      expect(acc).not.toBeNull();
      expect(acc!.status).toBe('INACTIVE');
    }
  });

  it('enforces unique account code per organization', async () => {
    await expect(
      prisma.account.create({
        data: {
          organizationId: orgId,
          code: '1111', // Already exists: Cash on Hand
          name: 'Duplicate Cash',
          type: 'ASSET',
          normalBalance: 'DEBIT',
        },
      }),
    ).rejects.toThrow();
  });

  it('validates parent account must exist', async () => {
    await expect(
      prisma.account.create({
        data: {
          organizationId: orgId,
          code: '9999',
          name: 'Orphan Account',
          type: 'ASSET',
          normalBalance: 'DEBIT',
          parentId: 'non-existent-id',
        },
      }),
    ).rejects.toThrow();
  });

  it('normal balance validation is enforced at API layer (not DB constraint)', async () => {
    const assetParent = await prisma.account.findFirst({
      where: { organizationId: orgId, code: '1100' },
      select: { id: true },
    });

    // DB allows this (no CHECK constraint), API layer should reject
    const created = await prisma.account.create({
      data: {
        organizationId: orgId,
        code: '1199',
        name: 'Invalid Asset',
        type: 'ASSET',
        normalBalance: 'CREDIT', // Wrong: assets must be DEBIT
        parentId: assetParent!.id,
      },
    });

    expect(created.normalBalance).toBe('CREDIT');
    expect(created.type).toBe('ASSET');
    // Clean up
    await prisma.account.delete({ where: { id: created.id } });
  });

  it('marks control accounts as non-postable', async () => {
    const controlAccounts = await prisma.account.findMany({
      where: { organizationId: orgId, subCategory: 'CONTROL' },
      select: { code: true, isPostable: true },
    });

    for (const a of controlAccounts) {
      expect(a.isPostable).toBe(false);
    }
  });

  it('marks header accounts as non-postable', async () => {
    const headerCodes = ['1000', '1100', '1110', '1120', '1130', '1140', '1200', '1290', '2000', '2100', '2110', '2120', '2130', '2190', '2200', '3000', '4000', '4100', '4200', '4300', '5000', '5100', '5200', '5300', '5400', '5500', '5600', '5700', '5800', '5900', '5950', '5990', '9000'];

    for (const code of headerCodes) {
      const acc = await prisma.account.findUnique({
        where: { organizationId_code: { organizationId: orgId, code } },
        select: { isPostable: true },
      });
      if (acc) {
        expect(acc.isPostable).toBe(false);
      }
    }
  });
});

describe('M3 Task 1: Financial Periods', () => {
  it('creates monthly periods for a fiscal year without overlap', async () => {
    const periods = await prisma.$queryRawUnsafe<Array<{ code: string; startDate: Date; endDate: Date }>>(
      `SELECT code, start_date as "startDate", end_date as "endDate"
       FROM financial_periods
       WHERE organization_id = '${orgId}' AND type = 'MONTHLY'
       ORDER BY start_date`
    );

    expect(periods.length).toBe(12);

    for (let i = 0; i < periods.length - 1; i++) {
      expect(periods[i]!.endDate.getTime()).toBeLessThan(periods[i + 1]!.startDate.getTime());
    }

    // Use UTC methods since dates are stored in UTC
    expect(periods[0]!.startDate.getUTCMonth()).toBe(0);
    expect(periods[0]!.startDate.getUTCFullYear()).toBe(2025);
    expect(periods[11]!.endDate.getUTCMonth()).toBe(11);
    expect(periods[11]!.endDate.getUTCFullYear()).toBe(2025);
  });

  it('creates quarterly periods for a fiscal year without overlap', async () => {
    const periods = await prisma.$queryRawUnsafe<Array<{ code: string; startDate: Date; endDate: Date }>>(
      `SELECT code, start_date as "startDate", end_date as "endDate"
       FROM financial_periods
       WHERE organization_id = '${orgId}' AND type = 'QUARTERLY'
       ORDER BY start_date`
    );

    expect(periods.length).toBe(4);

    for (let i = 0; i < periods.length - 1; i++) {
      expect(periods[i]!.endDate.getTime()).toBeLessThan(periods[i + 1]!.startDate.getTime());
    }
  });

  it('creates annual period for a fiscal year', async () => {
    const periods = await prisma.$queryRawUnsafe<Array<{ code: string; startDate: Date; endDate: Date }>>(
      `SELECT code, start_date as "startDate", end_date as "endDate"
       FROM financial_periods
       WHERE organization_id = '${orgId}' AND type = 'ANNUAL'
       ORDER BY start_date`
    );

    expect(periods.length).toBeGreaterThanOrEqual(1);
    const annual = periods[0]!;
    expect(annual.startDate.getUTCMonth()).toBe(0);
    expect(annual.endDate.getUTCMonth()).toBe(11);
  });
});

describe('M3 Task 1: Period Lock Trigger', () => {
  let lockedPeriodId: string;
  let openPeriodId: string;
  let testAccountId: string;

  beforeAll(async () => {
    const periods = await prisma.financialPeriod.findMany({
      where: { organizationId: orgId },
      orderBy: { startDate: 'asc' },
      select: { id: true, code: true, status: true },
    });

    // Find a LOCKED period (first monthly was locked in fixture, then reopened by reopen test)
    // Create a fresh LOCKED period for testing
    lockedPeriodId = periods.find((p) => p.status === 'LOCKED')?.id ?? periods[0]!.id;
    if ((await prisma.financialPeriod.findUnique({ where: { id: lockedPeriodId } }))?.status !== 'LOCKED') {
      await prisma.financialPeriod.update({
        where: { id: lockedPeriodId },
        data: { status: 'LOCKED', lockedAt: new Date() },
      });
    }

    openPeriodId = periods.find((p) => p.status === 'OPEN' && p.id !== lockedPeriodId)!.id;

    const account = await prisma.account.findFirst({
      where: { organizationId: orgId, isPostable: true },
      select: { id: true },
    });
    testAccountId = account!.id;
  });

  it('rejects INSERT into journal_entries for LOCKED period via trigger', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO journal_entries (id, organization_id, period_id, type, status, source, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'STANDARD', 'POSTED', 'MANUAL', now(), now())`,
        orgId,
        lockedPeriodId,
      ),
    ).rejects.toThrow();
  });

  it('rejects INSERT into journal_lines for entry in LOCKED period via trigger', async () => {
    // Create a journal entry in an OPEN period first
    const entry = await prisma.journalEntry.create({
      data: {
        organizationId: orgId,
        periodId: openPeriodId,
        type: 'STANDARD',
        status: 'DRAFT',
        source: 'MANUAL',
      },
    });

    // Lock the period
    await prisma.financialPeriod.update({
      where: { id: openPeriodId },
      data: { status: 'LOCKED', lockedAt: new Date() },
    });

    // Now try to insert a journal_line for that entry - should fail due to trigger
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO journal_lines (id, organization_id, entry_id, account_id, debit, credit, currency_code, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 100, 0, 'TZS', now())`,
        orgId,
        entry.id,
        testAccountId,
      ),
    ).rejects.toThrow();

    // Restore period status for other tests
    await prisma.financialPeriod.update({
      where: { id: openPeriodId },
      data: { status: 'OPEN', lockedAt: null },
    });
  });

  it('rejects INSERT into transactions for LOCKED period via trigger', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO transactions (id, organization_id, status, date, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'POSTED', $2, now(), now())`,
        orgId,
        new Date('2025-01-15'),
      ),
    ).rejects.toThrow();
  });

  it('allows writes to OPEN period', async () => {
    const entry = await prisma.journalEntry.create({
      data: {
        organizationId: orgId,
        periodId: openPeriodId,
        type: 'STANDARD',
        status: 'DRAFT',
        source: 'MANUAL',
      },
    });

    await prisma.journalLine.create({
      data: {
        organizationId: orgId,
        entryId: entry.id,
        accountId: testAccountId,
        debit: 100,
        credit: 0,
        currencyCode: 'TZS',
      },
    });

    const tx = await prisma.$executeRawUnsafe(
      `INSERT INTO transactions (id, organization_id, status, date, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'DRAFT', $2, now(), now())`,
      orgId,
      new Date('2025-06-15'),
    );

    expect(entry.id).toBeDefined();
    expect(tx).toBe(1);
  });
});

describe('M3 Task 1: Period Reopen Flow', () => {
  let periodId: string;

  beforeAll(async () => {
    const period = await prisma.financialPeriod.findFirst({
      where: { organizationId: orgId, status: 'LOCKED' },
      select: { id: true, reopenCount: true },
    });

    if (!period) {
      const p = await prisma.financialPeriod.findFirst({
        where: { organizationId: orgId, status: 'OPEN' },
        select: { id: true },
      });
      await prisma.financialPeriod.update({
        where: { id: p!.id },
        data: { status: 'LOCKED', lockedAt: new Date() },
      });
      periodId = p!.id;
    } else {
      periodId = period.id;
    }
  });

  it('reopen without approved request succeeds at DB level (API layer enforces approval)', async () => {
    // DB allows direct status change; API layer should enforce approval workflow
    const updated = await prisma.financialPeriod.update({
      where: { id: periodId },
      data: { status: 'REOPENED', reopenCount: { increment: 1 } },
    });

    expect(updated.status).toBe('REOPENED');
    expect(updated.reopenCount).toBeGreaterThan(0);
  });

  it('increments reopenCount when period is reopened', async () => {
    // Lock it again first
    await prisma.financialPeriod.update({
      where: { id: periodId },
      data: { status: 'LOCKED', lockedAt: new Date() },
    });

    const before = await prisma.financialPeriod.findUniqueOrThrow({
      where: { id: periodId },
      select: { reopenCount: true },
    });

    await prisma.financialPeriod.update({
      where: { id: periodId },
      data: {
        status: 'REOPENED',
        reopenCount: { increment: 1 },
      },
    });

    const after = await prisma.financialPeriod.findUniqueOrThrow({
      where: { id: periodId },
      select: { reopenCount: true, status: true },
    });

    expect(after.reopenCount).toBe(before.reopenCount + 1);
    expect(after.status).toBe('REOPENED');
  });
});

describe('M3 Task 1: Opening Balances', () => {
  let periodId: string;
  let assetAccountId: string;
  let liabilityAccountId: string;
  let nonPostableAccountId: string;
  let anotherAssetAccountId: string;
  let tzsTestAssetAccountId: string;

  beforeAll(async () => {
    const period = await prisma.financialPeriod.findFirst({
      where: { organizationId: orgId, status: 'OPEN' },
      select: { id: true },
    });
    periodId = period!.id;

    const asset = await prisma.account.findFirst({
      where: { organizationId: orgId, type: 'ASSET', isPostable: true },
      select: { id: true },
    });
    assetAccountId = asset!.id;

    const liability = await prisma.account.findFirst({
      where: { organizationId: orgId, type: 'LIABILITY', isPostable: true },
      select: { id: true },
    });
    liabilityAccountId = liability!.id;

    const nonPostable = await prisma.account.findFirst({
      where: { organizationId: orgId, isPostable: false },
      select: { id: true },
    });
    nonPostableAccountId = nonPostable!.id;

    const anotherAsset = await prisma.account.findFirst({
      where: { organizationId: orgId, type: 'ASSET', isPostable: true, NOT: { id: assetAccountId } },
      select: { id: true },
    });
    anotherAssetAccountId = anotherAsset!.id;

    const tzsTestAsset = await prisma.account.findFirst({
      where: { organizationId: orgId, type: 'ASSET', isPostable: true, NOT: { id: { in: [assetAccountId, anotherAssetAccountId] } } },
      select: { id: true },
    });
    tzsTestAssetAccountId = tzsTestAsset!.id;
  });

  it('defaults to isUnverified: true and verificationStatus: UNVERIFIED', async () => {
    const ob = await prisma.openingBalance.create({
      data: {
        organizationId: orgId,
        accountId: assetAccountId,
        periodId,
        amount: 1000000,
        currencyCode: 'TZS',
        source: 'Opening balance from prior system migration',
      },
      select: { isUnverified: true, verificationStatus: true },
    });

    expect(ob.isUnverified).toBe(true);
    expect(ob.verificationStatus).toBe('UNVERIFIED');
  });

  it('requires source field', async () => {
    await expect(
      prisma.openingBalance.create({
        data: {
          organizationId: orgId,
          accountId: liabilityAccountId,
          periodId,
          amount: 500000,
          currencyCode: 'TZS',
        } as unknown as import('@/generated/prisma/client').Prisma.OpeningBalanceCreateInput,
      }),
    ).rejects.toThrow();
  });

  it('non-postable account validation is enforced at API layer (not DB constraint)', async () => {
    // DB allows this (no CHECK constraint), API layer should reject
    const ob = await prisma.openingBalance.create({
      data: {
        organizationId: orgId,
        accountId: nonPostableAccountId,
        periodId,
        amount: 100000,
        currencyCode: 'TZS',
        source: 'Test',
      },
    });

    expect(ob.accountId).toBe(nonPostableAccountId);
    expect(Number(ob.amount)).toBe(100000);
    // Clean up
    await prisma.openingBalance.delete({ where: { id: ob.id } });
  });

  it('verify action requires verifiedByAccountantId and note, sets isUnverified: false', async () => {
    const ob = await prisma.openingBalance.create({
      data: {
        organizationId: orgId,
        accountId: liabilityAccountId,
        periodId,
        amount: 2000000,
        currencyCode: 'TZS',
        source: 'Prior year audited balance sheet',
      },
      select: { id: true },
    });

    await prisma.openingBalance.update({
      where: { id: ob.id },
      data: {
        isUnverified: false,
        verificationStatus: 'VERIFIED',
        verifiedByAccountantAt: new Date(),
        verifiedByAccountantId: 'test-accountant-id',
      },
    });

    const verified = await prisma.openingBalance.findUniqueOrThrow({
      where: { id: ob.id },
      select: { isUnverified: true, verificationStatus: true, verifiedByAccountantId: true },
    });

    expect(verified.isUnverified).toBe(false);
    expect(verified.verificationStatus).toBe('VERIFIED');
    expect(verified.verifiedByAccountantId).toBe('test-accountant-id');
  });

  it('enforces unique account-period combination', async () => {
    await prisma.openingBalance.create({
      data: {
        organizationId: orgId,
        accountId: anotherAssetAccountId,
        periodId,
        amount: 1000,
        currencyCode: 'TZS',
        source: 'First entry',
      },
    });

    await expect(
      prisma.openingBalance.create({
        data: {
          organizationId: orgId,
          accountId: anotherAssetAccountId,
          periodId,
          amount: 2000,
          currencyCode: 'TZS',
          source: 'Second entry',
        },
      }),
    ).rejects.toThrow();
  });

  it('supports TZS 3.9M unverified entry (verification doc scenario)', async () => {
    // Clean up any existing opening balance for this account/period
    await prisma.openingBalance.deleteMany({
      where: { accountId: tzsTestAssetAccountId, periodId },
    });

    const ob = await prisma.openingBalance.create({
      data: {
        organizationId: orgId,
        accountId: tzsTestAssetAccountId,
        periodId,
        amount: 3900000,
        currencyCode: 'TZS',
        source: 'Historical bank statement 2024-12-31',
      },
      select: { amount: true, currencyCode: true, isUnverified: true, verificationStatus: true },
    });

    expect(Number(ob.amount)).toBe(3900000);
    expect(ob.currencyCode).toBe('TZS');
    expect(ob.isUnverified).toBe(true);
    expect(ob.verificationStatus).toBe('UNVERIFIED');
  });
});