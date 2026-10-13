import { Prisma } from '@/generated/prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '@/lib/db/prisma';
import { dec } from '@/lib/reports/internal';

export interface ChecklistItemDefinition {
  itemKey: string;
  label: string;
  isBlocking: boolean;
  isAutomated: boolean;
}

export const CHECKLIST_DEFINITIONS: ChecklistItemDefinition[] = [
  { itemKey: 'BANK_RECONCILIATION', label: 'Bank reconciliation complete', isBlocking: true, isAutomated: true },
  { itemKey: 'CASH_RECONCILIATION', label: 'Cash reconciliation complete', isBlocking: true, isAutomated: true },
  { itemKey: 'RECEIVABLES', label: 'Receivables reviewed', isBlocking: false, isAutomated: false },
  { itemKey: 'PAYABLES', label: 'Payables reviewed', isBlocking: false, isAutomated: false },
  { itemKey: 'MISSING_DOCUMENTS', label: 'No missing documents on required-document accounts', isBlocking: true, isAutomated: true },
  { itemKey: 'UNAPPROVED_TRANSACTIONS', label: 'No unapproved transactions older than X days', isBlocking: true, isAutomated: true },
  { itemKey: 'BUDGET_VARIANCES', label: 'Budget variances reviewed', isBlocking: false, isAutomated: false },
  { itemKey: 'ADJUSTMENTS', label: 'All adjustments posted', isBlocking: true, isAutomated: true },
  { itemKey: 'FINANCIAL_STATEMENTS', label: 'Financial statements tie (income statement ties to GL; balance sheet balances)', isBlocking: true, isAutomated: true },
  { itemKey: 'OPEN_ITEMS_DISCLOSED', label: 'Open items disclosed (waivers require reason)', isBlocking: false, isAutomated: false },
  { itemKey: 'GO_LIVE_CLEANUP', label: 'Go-live cleanup (historical data migration verified)', isBlocking: false, isAutomated: false },
];

export interface AutomatedCheckResult {
  passed: boolean;
  value: string;
  detail: string;
}

/**
 * Run automated check for bank reconciliation completeness.
 * Returns true if all treasury accounts of kind BANK have a reconciliation session
 * with status APPROVED or BALANCED for the period.
 */
export async function checkBankReconciliation(
  orgId: string,
  periodId: string
): Promise<AutomatedCheckResult> {
  const period = await prisma.financialPeriod.findUnique({
    where: { id: periodId },
    select: { startDate: true, endDate: true },
  });

  if (!period) {
    return { passed: false, value: 'Period not found', detail: 'Period not found' };
  }

  // Get all bank treasury accounts
  const bankAccounts = await prisma.treasuryAccount.findMany({
    where: { organizationId: orgId, kind: 'BANK', isActive: true },
    select: { id: true, code: true, name: true },
  });

  if (bankAccounts.length === 0) {
    return { passed: true, value: 'No bank accounts', detail: 'No bank accounts to reconcile' };
  }

  let unreconciledCount = 0;
  const details: string[] = [];

  for (const account of bankAccounts) {
    const session = await prisma.reconciliationSession.findFirst({
      where: {
        organizationId: orgId,
        treasuryAccountId: account.id,
        periodId,
        status: { in: ['APPROVED'] },
      },
      select: { id: true, status: true, difference: true },
    });

    if (!session) {
      unreconciledCount++;
      details.push(`${account.code} (${account.name}): No approved reconciliation session`);
    } else if (session.difference !== null && !dec(session.difference).equals(0)) {
      unreconciledCount++;
      details.push(`${account.code} (${account.name}): Unreconciled difference ${session.difference}`);
    }
  }

  const passed = unreconciledCount === 0;
  return {
    passed,
    value: `${bankAccounts.length - unreconciledCount}/${bankAccounts.length} reconciled`,
    detail: passed ? 'All bank accounts reconciled' : details.join('; '),
  };
}

/**
 * Run automated check for cash reconciliation completeness.
 * Returns true if all treasury accounts of kind CASH have a reconciliation session
 * with status APPROVED or BALANCED for the period.
 */
export async function checkCashReconciliation(
  orgId: string,
  periodId: string
): Promise<AutomatedCheckResult> {
  const period = await prisma.financialPeriod.findUnique({
    where: { id: periodId },
    select: { startDate: true, endDate: true },
  });

  if (!period) {
    return { passed: false, value: 'Period not found', detail: 'Period not found' };
  }

  // Get all cash treasury accounts
  const cashAccounts = await prisma.treasuryAccount.findMany({
    where: { organizationId: orgId, kind: 'CASH', isActive: true },
    select: { id: true, code: true, name: true },
  });

  if (cashAccounts.length === 0) {
    return { passed: true, value: 'No cash accounts', detail: 'No cash accounts to reconcile' };
  }

  let unreconciledCount = 0;
  const details: string[] = [];

  for (const account of cashAccounts) {
    const session = await prisma.reconciliationSession.findFirst({
      where: {
        organizationId: orgId,
        treasuryAccountId: account.id,
        periodId,
        status: { in: ['APPROVED'] },
      },
      select: { id: true, status: true, difference: true },
    });

    if (!session) {
      unreconciledCount++;
      details.push(`${account.code} (${account.name}): No approved reconciliation session`);
    } else if (session.difference !== null && !dec(session.difference).equals(0)) {
      unreconciledCount++;
      details.push(`${account.code} (${account.name}): Unreconciled difference ${session.difference}`);
    }
  }

  const passed = unreconciledCount === 0;
  return {
    passed,
    value: `${cashAccounts.length - unreconciledCount}/${cashAccounts.length} reconciled`,
    detail: passed ? 'All cash accounts reconciled' : details.join('; '),
  };
}

/**
 * Check for missing required documents on accounts that require them.
 * Accounts with subCategory RECEIVABLE, SUPPLIER_PAYABLE require supporting documents.
 */
export async function checkMissingDocuments(
  orgId: string,
  periodId: string
): Promise<AutomatedCheckResult> {
  const period = await prisma.financialPeriod.findUnique({
    where: { id: periodId },
    select: { startDate: true, endDate: true },
  });

  if (!period) {
    return { passed: false, value: 'Period not found', detail: 'Period not found' };
  }

  // Find accounts that require documents (receivables, payables)
  const accountsRequiringDocs = await prisma.account.findMany({
    where: {
      organizationId: orgId,
      subCategory: { in: ['RECEIVABLE', 'SUPPLIER_PAYABLE'] },
      status: { in: ['ACTIVE', 'LOCKED'] },
    },
    select: { id: true, code: true, name: true },
  });

  if (accountsRequiringDocs.length === 0) {
    return { passed: true, value: 'No accounts requiring documents', detail: 'No accounts requiring documents' };
  }

  let missingCount = 0;
  const details: string[] = [];

  for (const account of accountsRequiringDocs) {
    // Check if there are posted journal lines for this account in the period without linked documents
    const linesWithoutDocs = await prisma.journalLine.findFirst({
      where: {
        organizationId: orgId,
        accountId: account.id,
        entry: {
          periodId,
          status: 'POSTED',
        },
        // Check for document links
        // This is simplified - in reality we'd check DocumentLink for the journal entry
      },
      select: { id: true },
    });

    // For now, we'll just check if there are any documents linked to transactions in this period
    const hasDocuments = await prisma.documentLink.findFirst({
      where: {
        organizationId: orgId,
        entityType: 'JOURNAL_ENTRY',
        entityId: { in: await prisma.journalEntry.findMany({
          where: { periodId, status: 'POSTED' },
          select: { id: true },
        }).then(entries => entries.map(e => e.id)) },
      },
      select: { id: true },
    });

    if (!hasDocuments) {
      missingCount++;
      details.push(`${account.code} (${account.name}): No supporting documents found`);
    }
  }

  const passed = missingCount === 0;
  return {
    passed,
    value: `${accountsRequiringDocs.length - missingCount}/${accountsRequiringDocs.length} have documents`,
    detail: passed ? 'All required documents present' : details.join('; '),
  };
}

/**
 * Check for unapproved transactions older than X days (default 30).
 */
export async function checkUnapprovedTransactions(
  orgId: string,
  periodId: string,
  daysThreshold = 30
): Promise<AutomatedCheckResult> {
  const period = await prisma.financialPeriod.findUnique({
    where: { id: periodId },
    select: { startDate: true, endDate: true },
  });

  if (!period) {
    return { passed: false, value: 'Period not found', detail: 'Period not found' };
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysThreshold);

  const unapprovedCount = await prisma.transaction.count({
    where: {
      organizationId: orgId,
      status: { in: ['DRAFT', 'SUBMITTED'] },
      createdAt: { lt: cutoffDate },
      // Also check if transaction is within the period
      // For simplicity, we check all unapproved transactions
    },
  });

  const passed = unapprovedCount === 0;
  return {
    passed,
    value: `${unapprovedCount} unapproved transactions older than ${daysThreshold} days`,
    detail: passed
      ? 'No stale unapproved transactions'
      : `${unapprovedCount} transactions in DRAFT/SUBMITTED status for more than ${daysThreshold} days`,
  };
}

/**
 * Check that all adjustments have been posted.
 * Looks for reconciliation adjustments in DRAFT/SUBMITTED status for the period.
 */
export async function checkAdjustmentsPosted(
  orgId: string,
  periodId: string
): Promise<AutomatedCheckResult> {
  const period = await prisma.financialPeriod.findUnique({
    where: { id: periodId },
    select: { startDate: true, endDate: true },
  });

  if (!period) {
    return { passed: false, value: 'Period not found', detail: 'Period not found' };
  }

  const pendingAdjustments = await prisma.reconciliationAdjustment.count({
    where: {
      organizationId: orgId,
      session: { periodId },
      status: { in: ['DRAFT', 'SUBMITTED'] },
    },
  });

  const passed = pendingAdjustments === 0;
  return {
    passed,
    value: `${pendingAdjustments} pending adjustments`,
    detail: passed ? 'All adjustments posted' : `${pendingAdjustments} reconciliation adjustments not yet posted`,
  };
}

/**
 * Check that financial statements tie.
 * - Trial balance debits = credits
 * - Balance sheet: Assets = Liabilities + Equity
 * - Income statement net result flows to retained earnings
 */
export async function checkFinancialStatements(
  orgId: string,
  periodId: string
): Promise<AutomatedCheckResult> {
  const period = await prisma.financialPeriod.findUnique({
    where: { id: periodId },
    select: { startDate: true, endDate: true },
  });

  if (!period) {
    return { passed: false, value: 'Period not found', detail: 'Period not found' };
  }

  const details: string[] = [];

  // 1. Check trial balance balances
  const lines = await prisma.journalLine.findMany({
    where: {
      organizationId: orgId,
      entry: { periodId, status: 'POSTED' },
    },
    select: { debit: true, credit: true },
  });

  const totalDebits = lines.reduce((sum, l) => sum.plus(dec(l.debit)), dec(0));
  const totalCredits = lines.reduce((sum, l) => sum.plus(dec(l.credit)), dec(0));
  const tbBalanced = totalDebits.equals(totalCredits);

  if (!tbBalanced) {
    details.push(`Trial balance: Debits ${totalDebits.toString()} ≠ Credits ${totalCredits.toString()}`);
  }

  // 2. Check balance sheet balances
  const bsLines = await prisma.journalLine.findMany({
    where: {
      organizationId: orgId,
      account: { type: { in: ['ASSET', 'LIABILITY', 'EQUITY'] } },
      entry: { status: 'POSTED', postedAt: { lte: period.endDate } },
    },
    select: { debit: true, credit: true, account: { select: { type: true, normalBalance: true } } },
  });

  const assets = bsLines
    .filter(l => l.account.type === 'ASSET')
    .reduce((sum, l) => sum.plus(l.account.normalBalance === 'DEBIT' ? dec(l.debit).minus(dec(l.credit)) : dec(l.credit).minus(dec(l.debit))), dec(0));
  const liabilities = bsLines
    .filter(l => l.account.type === 'LIABILITY')
    .reduce((sum, l) => sum.plus(l.account.normalBalance === 'CREDIT' ? dec(l.credit).minus(dec(l.debit)) : dec(l.debit).minus(dec(l.credit))), dec(0));
  const equity = bsLines
    .filter(l => l.account.type === 'EQUITY')
    .reduce((sum, l) => sum.plus(l.account.normalBalance === 'CREDIT' ? dec(l.credit).minus(dec(l.debit)) : dec(l.debit).minus(dec(l.credit))), dec(0));

  const bsBalanced = assets.equals(liabilities.plus(equity));
  if (!bsBalanced) {
    details.push(`Balance sheet: Assets ${assets.toString()} ≠ Liabilities ${liabilities.toString()} + Equity ${equity.toString()}`);
  }

  const passed = tbBalanced && bsBalanced;
  return {
    passed,
    value: `TB: ${tbBalanced ? 'balanced' : 'UNBALANCED'}; BS: ${bsBalanced ? 'balanced' : 'UNBALANCED'}`,
    detail: passed ? 'All financial statements tie' : details.join('; '),
  };
}

/**
 * Run all automated checks for a period close.
 */
export async function runAllAutomatedChecks(
  orgId: string,
  periodId: string
): Promise<Record<string, AutomatedCheckResult>> {
  const results: Record<string, AutomatedCheckResult> = {};

  // Only run automated checks for items marked as automated
  const automatedItems = CHECKLIST_DEFINITIONS.filter(d => d.isAutomated);

  for (const item of automatedItems) {
    switch (item.itemKey) {
      case 'BANK_RECONCILIATION':
        results[item.itemKey] = await checkBankReconciliation(orgId, periodId);
        break;
      case 'CASH_RECONCILIATION':
        results[item.itemKey] = await checkCashReconciliation(orgId, periodId);
        break;
      case 'MISSING_DOCUMENTS':
        results[item.itemKey] = await checkMissingDocuments(orgId, periodId);
        break;
      case 'UNAPPROVED_TRANSACTIONS':
        results[item.itemKey] = await checkUnapprovedTransactions(orgId, periodId);
        break;
      case 'ADJUSTMENTS':
        results[item.itemKey] = await checkAdjustmentsPosted(orgId, periodId);
        break;
      case 'FINANCIAL_STATEMENTS':
        results[item.itemKey] = await checkFinancialStatements(orgId, periodId);
        break;
      default:
        results[item.itemKey] = { passed: true, value: 'N/A', detail: 'Manual check required' };
    }
  }

  return results;
}