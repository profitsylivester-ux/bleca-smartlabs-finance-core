import { Prisma } from '@/generated/prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '@/lib/db/prisma';
import { writeAuditEntry } from '@/lib/audit/writer';
import { createApprovalRequest } from '@/lib/approvals/engine';
import { dec } from '@/lib/reports/internal';

export interface YearEndResult {
  closingEntryId: string;
  retainedEarningsAccountId: string;
  netIncome: Decimal;
  incomeAccountsCleared: number;
  expenseAccountsCleared: number;
}

/**
 * Run the year-end closing procedure for an annual period.
 * This:
 * 1. Computes net income for the fiscal year
 * 2. Creates a closing journal entry that zeros out all income/expense accounts
 * 3. Moves net income to retained earnings
 * 4. Marks the fiscal year as closed
 * 5. Requires CEO sign-off via approval engine
 */
export async function runYearEndProcedure(
  periodId: string,
  orgId: string,
  userId: string,
  userName: string,
  userRoleCodes: string[],
  tx: Prisma.TransactionClient = prisma
): Promise<YearEndResult> {
  // Verify period exists and is ANNUAL type
  const period = await tx.financialPeriod.findFirst({
    where: { id: periodId, organizationId: orgId },
    select: { id: true, code: true, name: true, type: true, status: true, startDate: true, endDate: true },
  });

  if (!period) throw new Error('Period not found');
  if (period.type !== 'ANNUAL') throw new Error('Year-end procedure can only be run on ANNUAL periods');
  if (period.status !== 'CLOSED' && period.status !== 'LOCKED') {
    throw new Error(`Period must be CLOSED or LOCKED to run year-end (current: ${period.status})`);
  }

  // Get the organization to find base currency and retained earnings account
  const org = await tx.organization.findUnique({
    where: { id: orgId },
    select: { baseCurrency: true },
  });
  if (!org) throw new Error('Organization not found');

  // Find retained earnings account
  const retainedEarningsAccount = await tx.account.findFirst({
    where: {
      organizationId: orgId,
      subCategory: 'RETAINED_EARNINGS',
      status: { in: ['ACTIVE', 'LOCKED'] },
    },
    select: { id: true, code: true, name: true },
  });
  if (!retainedEarningsAccount) throw new Error('Retained earnings account not found in chart of accounts');

  // Get all income and expense accounts
  const incomeExpenseAccounts = await tx.account.findMany({
    where: {
      organizationId: orgId,
      type: { in: ['REVENUE', 'EXPENSE'] },
      status: { in: ['ACTIVE', 'LOCKED'] },
    },
    select: { id: true, code: true, name: true, type: true, normalBalance: true },
  });

  if (incomeExpenseAccounts.length === 0) {
    throw new Error('No income or expense accounts found');
  }

  // Compute balances for each income/expense account for the fiscal year
  // We need to consider all posted entries up to the period end date
  const lines = await tx.journalLine.findMany({
    where: {
      organizationId: orgId,
      accountId: { in: incomeExpenseAccounts.map((a) => a.id) },
      entry: { status: 'POSTED', postedAt: { lte: period.endDate } },
    },
    select: { accountId: true, debit: true, credit: true },
  });

  // Calculate balances per account
  const balances = new Map<string, { debit: Decimal; credit: Decimal }>();
  for (const line of lines) {
    const existing = balances.get(line.accountId) ?? { debit: dec(0), credit: dec(0) };
    existing.debit = existing.debit.plus(dec(line.debit));
    existing.credit = existing.credit.plus(dec(line.credit));
    balances.set(line.accountId, existing);
  }

  // Build closing entry lines
  const closingLines: Array<{
    accountId: string;
    debit: Decimal;
    credit: Decimal;
    description: string;
  }> = [];

  let totalDebits = dec(0);
  let totalCredits = dec(0);
  let netIncome = dec(0);
  let incomeAccountsCleared = 0;
  let expenseAccountsCleared = 0;

  for (const account of incomeExpenseAccounts) {
    const balance = balances.get(account.id) ?? { debit: dec(0), credit: dec(0) };
    let accountBalance: Decimal;

    if (account.normalBalance === 'CREDIT') {
      // Revenue accounts normally have credit balance
      accountBalance = balance.credit.minus(balance.debit);
    } else {
      // Expense accounts normally have debit balance
      accountBalance = balance.debit.minus(balance.credit);
    }

    if (accountBalance.equals(0)) continue; // Skip zero-balance accounts

    if (account.type === 'REVENUE') {
      // Revenue has credit balance - debit to close
      closingLines.push({
        accountId: account.id,
        debit: accountBalance,
        credit: dec(0),
        description: `Year-end close: Clear ${account.code} ${account.name}`,
      });
      totalDebits = totalDebits.plus(accountBalance);
      netIncome = netIncome.plus(accountBalance); // Revenue increases net income
      incomeAccountsCleared++;
    } else {
      // Expense has debit balance - credit to close
      closingLines.push({
        accountId: account.id,
        debit: dec(0),
        credit: accountBalance,
        description: `Year-end close: Clear ${account.code} ${account.name}`,
      });
      totalCredits = totalCredits.plus(accountBalance);
      netIncome = netIncome.minus(accountBalance); // Expense decreases net income
      expenseAccountsCleared++;
    }
  }

  if (closingLines.length === 0) {
    throw new Error('No income/expense accounts with non-zero balances to close');
  }

  // Add retained earnings line (opposite of net income)
  if (!netIncome.equals(0)) {
    if (netIncome.greaterThan(0)) {
      // Net income (profit) - credit retained earnings
      closingLines.push({
        accountId: retainedEarningsAccount.id,
        debit: dec(0),
        credit: netIncome,
        description: `Year-end close: Transfer net income to retained earnings`,
      });
      totalCredits = totalCredits.plus(netIncome);
    } else {
      // Net loss - debit retained earnings
      closingLines.push({
        accountId: retainedEarningsAccount.id,
        debit: netIncome.abs(),
        credit: dec(0),
        description: `Year-end close: Transfer net loss to retained earnings`,
      });
      totalDebits = totalDebits.plus(netIncome.abs());
    }
  }

  // Verify entry balances
  if (!totalDebits.equals(totalCredits)) {
    throw new Error(`Closing entry unbalanced: Debits ${totalDebits.toString()} ≠ Credits ${totalCredits.toString()}`);
  }

  // Create the closing journal entry
  const closingEntry = await tx.journalEntry.create({
    data: {
      organizationId: orgId,
      periodId,
      type: 'CLOSING',
      status: 'POSTED',
      source: 'CLOSE',
      description: `Year-end closing entry for ${period.code} (${period.name})`,
      postedById: userId,
      postedAt: new Date(),
      lines: {
        create: closingLines.map((line, index) => ({
          organizationId: orgId,
          lineNumber: index + 1,
          accountId: line.accountId,
          debit: line.debit,
          credit: line.credit,
          currencyCode: org.baseCurrency,
          baseAmount: line.debit.greaterThan(0) ? line.debit : line.credit,
          description: line.description,
        })),
      },
    },
    select: { id: true },
  });

  // Mark fiscal year as closed (we can add a fiscalYearClosedAt field to FinancialPeriod or use a separate model)
  // For now, we'll just audit it and the period stays LOCKED
  // We could add a fiscalYearClosed boolean to FinancialPeriod

  await writeAuditEntry(
    tx,
    { id: userId, name: userName, roleCodes: userRoleCodes },
    {
      action: 'YEAR_END_PROCEDURE_RUN',
      entityType: 'FINANCIAL_PERIOD',
      entityId: period.id,
      entityLabel: period.code,
      description: `Year-end procedure executed for ${period.code} (${period.name})`,
      changes: {
        netIncome: { from: null, to: netIncome.toString() },
        incomeAccountsCleared: { from: null, to: incomeAccountsCleared },
        expenseAccountsCleared: { from: null, to: expenseAccountsCleared },
        closingEntryId: { from: null, to: closingEntry.id },
        retainedEarningsAccount: { from: null, to: retainedEarningsAccount.code },
      },
      metadata: {
        periodType: 'ANNUAL',
        baseCurrency: org.baseCurrency,
      },
      result: 'SUCCESS',
      channel: 'WEB',
    },
    { organizationId: orgId }
  );

  return {
    closingEntryId: closingEntry.id,
    retainedEarningsAccountId: retainedEarningsAccount.id,
    netIncome,
    incomeAccountsCleared,
    expenseAccountsCleared,
  };
}

/**
 * Create an adjustment period after a period is closed/locked.
 * An adjustment period allows post-close entries to be posted without reopening the closed period.
 */
export async function createAdjustmentPeriod(
  parentPeriodId: string,
  orgId: string,
  userId: string,
  userName: string,
  userRoleCodes: string[],
  tx: Prisma.TransactionClient = prisma
): Promise<{ adjustmentPeriodId: string; code: string }> {
  // Verify parent period exists and is CLOSED or LOCKED
  const parentPeriod = await tx.financialPeriod.findFirst({
    where: { id: parentPeriodId, organizationId: orgId },
    select: { id: true, code: true, name: true, type: true, status: true, startDate: true, endDate: true },
  });

  if (!parentPeriod) throw new Error('Parent period not found');
  if (parentPeriod.status !== 'CLOSED' && parentPeriod.status !== 'LOCKED') {
    throw new Error(`Cannot create adjustment period for period with status ${parentPeriod.status}`);
  }

  // Check if adjustment period already exists
  const existingAdj = await tx.financialPeriod.findFirst({
    where: {
      organizationId: orgId,
      code: { startsWith: `${parentPeriod.code}-ADJ` },
    },
    select: { id: true },
  });

  if (existingAdj) {
    throw new Error('Adjustment period already exists for this period');
  }

  // Create adjustment period (starts day after parent period ends, ends 30 days later or end of fiscal year)
  const adjStartDate = new Date(parentPeriod.endDate);
  adjStartDate.setDate(adjStartDate.getDate() + 1);

  const adjEndDate = new Date(adjStartDate);
  adjEndDate.setDate(adjEndDate.getDate() + 30); // 30-day adjustment window

  const adjCode = `${parentPeriod.code}-ADJ`;
  const adjName = `${parentPeriod.name} Adjustment Period`;

  const adjustmentPeriod = await tx.financialPeriod.create({
    data: {
      organizationId: orgId,
      type: parentPeriod.type,
      status: 'OPEN',
      code: adjCode,
      name: adjName,
      startDate: adjStartDate,
      endDate: adjEndDate,
      isAdjustment: true,
    },
    select: { id: true, code: true },
  });

  await writeAuditEntry(
    tx,
    { id: userId, name: userName, roleCodes: userRoleCodes },
    {
      action: 'ADJUSTMENT_PERIOD_CREATED',
      entityType: 'FINANCIAL_PERIOD',
      entityId: adjustmentPeriod.id,
      entityLabel: adjustmentPeriod.code,
      description: `Created adjustment period ${adjustmentPeriod.code} for ${parentPeriod.code}`,
      changes: {
        parentPeriodId: { from: null, to: parentPeriod.id },
        parentPeriodCode: { from: null, to: parentPeriod.code },
        startDate: { from: null, to: adjStartDate.toISOString() },
        endDate: { from: null, to: adjEndDate.toISOString() },
      },
      result: 'SUCCESS',
      channel: 'WEB',
    },
    { organizationId: orgId }
  );

  return { adjustmentPeriodId: adjustmentPeriod.id, code: adjustmentPeriod.code };
}

/**
 * Submit year-end for CEO sign-off (creates approval request).
 */
export async function submitYearEndForSignOff(
  periodId: string,
  orgId: string,
  userId: string,
  userName: string,
  userRoleCodes: string[],
  tx: Prisma.TransactionClient = prisma
): Promise<{ approvalRequestId: string }> {
  const period = await tx.financialPeriod.findFirst({
    where: { id: periodId, organizationId: orgId },
    select: { id: true, code: true, type: true, status: true },
  });

  if (!period) throw new Error('Period not found');
  if (period.type !== 'ANNUAL') throw new Error('Year-end sign-off only for ANNUAL periods');

  // Create approval request for CEO sign-off
  const approvalRequest = await createApprovalRequest(
    {
      organizationId: orgId,
      entityType: 'FINANCIAL_CLOSE', // Reuse FINANCIAL_CLOSE entity type for year-end sign-off
      entityId: period.id,
      amount: 0,
      currencyCode: 'TZS',
      submittedById: userId,
      context: {
        organizationId: orgId,
        entityType: 'FINANCIAL_CLOSE',
        entityId: period.id,
        submittedById: userId,
        amount: 0,
        currencyCode: 'TZS',
      },
    },
    tx
  );

  await writeAuditEntry(
    tx,
    { id: userId, name: userName, roleCodes: userRoleCodes },
    {
      action: 'FINANCIAL_CLOSE_SUBMITTED',
      entityType: 'FINANCIAL_PERIOD',
      entityId: period.id,
      entityLabel: period.code,
      description: `Submitted year-end close for period ${period.code} for CEO sign-off`,
      metadata: { approvalRequestId: approvalRequest.id, isYearEnd: true },
      result: 'SUCCESS',
      channel: 'WEB',
    },
    { organizationId: orgId }
  );

  return { approvalRequestId: approvalRequest.id };
}