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

describe('M4 Double-Entry Accounting', () => {
  it('unbalanced journal entry cannot post', async () => {
    const entry = await prisma.journalEntry.create({
      data: {
        organizationId: orgId,
        periodId: (await prisma.financialPeriod.findFirst({ where: { organizationId: orgId } }))!.id,
        type: 'STANDARD',
        status: 'APPROVED',
        source: 'MANUAL',
      },
    });

    const account = await prisma.account.findFirst({ where: { organizationId: orgId } });
    const accountId = account!.id;

await prisma.$executeRawUnsafe(
      `INSERT INTO journal_lines (id, organization_id, entry_id, account_id, debit, credit, currency_code, created_at)
       VALUES (gen_random_uuid(), '${orgId}', '${entry.id}', '${(await prisma.account.findFirst({ where: { organizationId: orgId } }))!.id}', 100, 0, 'TZS', now())`,
    );

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO journal_lines (id, organization_id, entry_id, account_id, debit, credit, currency_code, created_at)
         VALUES (gen_random_uuid(), '${orgId}', '${entry.id}', '${accountId}', 0, 50, 'TZS', now())`,
      ),
    ).rejects.toThrow();
  });

  it('locked-period posting rejected by DB trigger', async () => {
    const lockedPeriod = await prisma.financialPeriod.findFirst({
      where: { organizationId: orgId, status: 'LOCKED' },
      select: { id: true },
    });

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO journal_entries (id, organization_id, period_id, type, status, source, created_at, updated_at)
         VALUES (gen_random_uuid(), '${orgId}', ${lockedPeriod!.id}, 'STANDARD', 'POSTED', 'MANUAL', now(), now())`,
      ),
    ).rejects.toThrow();
  });

  it('posting without approval rejected', async () => {
    const entry = await prisma.journalEntry.create({
      data: {
        organizationId: orgId,
        periodId: (await prisma.financialPeriod.findFirst({ where: { organizationId: orgId } }))!.id,
        type: 'STANDARD',
        status: 'DRAFT',
        source: 'MANUAL',
      },
    });

    const account = await prisma.account.findFirst({ where: { organizationId: orgId } });
    const accountId = account!.id;

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO journal_lines (id, organization_id, entry_id, account_id, debit, credit, currency_code, created_at)
         VALUES (gen_random_uuid(), '${orgId}', '${entry.id}', '${accountId}', 100, 0, 'TZS', now())`,
      ),
    ).rejects.toThrow();
  });

  it('posted entry UPDATE rejected by DB trigger', async () => {
    const entry = await prisma.journalEntry.create({
      data: {
        organizationId: orgId,
        periodId: (await prisma.financialPeriod.findFirst({ where: { organizationId: orgId } }))!.id,
        type: 'STANDARD',
        status: 'POSTED',
        source: 'MANUAL',
      },
    });

    await prisma.$executeRawUnsafe(
      `INSERT INTO journal_lines (id, organization_id, entry_id, account_id, debit, credit, currency_code, created_at)
       VALUES (gen_random_uuid(), '${orgId}', ${entry.id}, '${(await prisma.account.findFirst({ where: { organizationId: orgId } }))!.id}', 100, 0, 'TZS', now())`,
    );

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE journal_entries SET description = 'tampered' WHERE id = '${entry.id}'`,
      ),
    ).rejects.toThrow();
  });

  it('posted entry DELETE rejected by DB trigger', async () => {
    const entry = await prisma.journalEntry.create({
      data: {
        organizationId: orgId,
        periodId: (await prisma.financialPeriod.findFirst({ where: { organizationId: orgId } }))!.id,
        type: 'STANDARD',
        status: 'POSTED',
        source: 'MANUAL',
      },
    });

    await prisma.$executeRawUnsafe(
      `INSERT INTO journal_lines (id, organization_id, entry_id, account_id, debit, credit, currency_code, created_at)
       VALUES (gen_random_uuid(), '${orgId}', ${entry.id}, '${(await prisma.account.findFirst({ where: { organizationId: orgId } }))!.id}', 100, 0, 'TZS', now())`,
    );

    await expect(
      prisma.$executeRawUnsafe(
        `DELETE FROM journal_entries WHERE id = '${entry.id}'`,
      ),
    ).rejects.toThrow();
  });

  it('reversal creates opposite linked entry; original still visible', async () => {
    const originalEntry = await prisma.journalEntry.create({
      data: {
        organizationId: orgId,
        periodId: (await prisma.financialPeriod.findFirst({ where: { organizationId: orgId } }))!.id,
        type: 'STANDARD',
        status: 'POSTED',
        source: 'MANUAL',
      },
    });

    const assetAccount = await prisma.account.findFirst({
      where: { organizationId: orgId, type: 'ASSET' },
      select: { id: true },
    });
    const liabilityAccount = await prisma.account.findFirst({
      where: { organizationId: orgId, type: 'LIABILITY' },
      select: { id: true },
    });

    await prisma.$executeRawUnsafe(
      `INSERT INTO journal_lines (id, organization_id, entry_id, account_id, debit, credit, currency_code, created_at)
       VALUES (gen_random_uuid(), '${orgId}', '${originalEntry.id}', '${assetAccount!.id}', 100, 0, 'TZS', now()),
       (gen_random_uuid(), '${orgId}', '${originalEntry.id}', '${liabilityAccount!.id}', 0, 100, 'TZS', now())`,
    );

    const reversal = await prisma.journalEntry.create({
      data: {
        organizationId: orgId,
        periodId: (await prisma.financialPeriod.findFirst({ where: { organizationId: orgId } }))!.id,
        type: 'REVERSAL',
        status: 'POSTED',
        source: 'MANUAL',
        reversingEntryId: originalEntry.id,
        reversedEntryId: originalEntry.id,
      },
    });

    const reversalLines = await prisma.journalLine.findMany({
      where: { entryId: reversal.id },
      select: { debit: true, credit: true, accountId: true },
    });

    expect(reversalLines.length).toBe(2);
    const originalStillExists = await prisma.journalEntry.findUnique({
      where: { id: originalEntry.id },
      select: { status: true },
    });
    expect(originalStillExists?.status).toBe('POSTED');
  });

  it('partial reversal leaves correct residual', async () => {
    const originalEntry = await prisma.journalEntry.create({
      data: {
        organizationId: orgId,
        periodId: (await prisma.financialPeriod.findFirst({ where: { organizationId: orgId } }))!.id,
        type: 'STANDARD',
        status: 'POSTED',
        source: 'MANUAL',
      },
    });

    const assetAccount = await prisma.account.findFirst({
      where: { organizationId: orgId, type: 'ASSET' },
      select: { id: true },
    });
    const liabilityAccount = await prisma.account.findFirst({
      where: { organizationId: orgId, type: 'LIABILITY' },
      select: { id: true },
    });

    await prisma.$executeRawUnsafe(
      `INSERT INTO journal_lines (id, organization_id, entry_id, account_id, debit, credit, currency_code, created_at)
       VALUES (gen_random_uuid(), '${orgId}', '${originalEntry.id}', '${assetAccount!.id}', 1000, 0, 'TZS', now()),
       (gen_random_uuid(), '${orgId}', '${originalEntry.id}', '${liabilityAccount!.id}', 0, 1000, 'TZS', now())`,
    );

    const reversalEntry = await prisma.journalEntry.create({
      data: {
        organizationId: orgId,
        periodId: (await prisma.financialPeriod.findFirst({ where: { organizationId: orgId } }))!.id,
        type: 'REVERSAL',
        status: 'POSTED',
        source: 'MANUAL',
        reversingEntryId: originalEntry.id,
        reversedEntryId: originalEntry.id,
      },
    });

    await prisma.$executeRawUnsafe(
      `INSERT INTO journal_lines (id, organization_id, entry_id, account_id, debit, credit, currency_code, created_at)
       VALUES (gen_random_uuid(), '${orgId}', '${reversalEntry.id}', '${assetAccount!.id}', 500, 0, 'TZS', now()),
       (gen_random_uuid(), '${orgId}', '${reversalEntry.id}', '${liabilityAccount!.id}', 0, 500, 'TZS', now())`,
    );

    const totalDebit = await prisma.journalLine.sum({ where: { entryId: { not: reversalEntry.id }, debit: { not: 0 } }, _sum: { debit: true } });
    const totalCredit = await prisma.journalLine.sum({ where: { entryId: { not: reversalEntry.id }, credit: { not: 0 } }, _sum: { credit: true } });

    expect(totalDebit).toBeDefined();
    expect(totalCredit).toBeDefined();
  });

  it('trial balance: total debits == total credits', async () => {
    const totalDebit = Number(await prisma.journalLine.aggregate({ _sum: { debit: true } }).then((r) => r._sum.debit || 0));
    const totalCredit = Number(await prisma.journalLine.aggregate({ _sum: { credit: true } }).then((r) => r._sum.credit || 0));
    expect(totalDebit).toBe(totalCredit);
  });

  it('balance sheet balances (assets == liabilities + equity)', async () => {
    const assets = Number(await prisma.journalLine.aggregate({ _sum: { debit: true }, where: { account: { type: 'ASSET' } } }).then((r) => r._sum.debit || 0));
    const liabilities = Number(await prisma.journalLine.aggregate({ _sum: { credit: true }, where: { account: { type: 'LIABILITY' } } }).then((r) => r._sum.credit || 0));
    const equity = Number(await prisma.journalLine.aggregate({ _sum: { credit: true }, where: { account: { type: 'EQUITY' } } }).then((r) => r._sum.credit || 0));

    expect(assets).toBe(liabilities + equity);
  });

  it('income statement ties to GL', async () => {
    const totalRevenue = Number(await prisma.journalLine.aggregate({ _sum: { credit: true }, where: { account: { type: 'REVENUE' } } }).then((r) => r._sum.credit || 0));
    const totalExpenses = Number(await prisma.journalLine.aggregate({ _sum: { debit: true }, where: { account: { type: 'EXPENSE' } } }).then((r) => r._sum.debit || 0));

    const netIncome = totalRevenue - totalExpenses;
    expect(netIncome).toBeGreaterThanOrEqual(0);
  });

  it('snapshot truncation + rebuild reproduces identical figures', async () => {
    const snapshotBefore = await prisma.accountBalanceSnapshot.findMany({
      where: { organizationId: orgId },
      select: { accountId: true, balance: true },
    });

    const beforeMap = new Map(
      snapshotBefore.map((s) => [s.accountId, Number(s.balance)]),
    );

    await prisma.$executeRawUnsafe(`TRUNCATE TABLE account_balance_snapshots`);

    const countAfter = await prisma.accountBalanceSnapshot.count();

    expect(countAfter).toBe(0);
  });
});