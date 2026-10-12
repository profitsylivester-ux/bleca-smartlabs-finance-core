import { Prisma } from '@/generated/prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';

/**
 * Budget availability engine (M9, PDF §13 + §67).
 *
 * The one formula this module exists to hold exactly, to the shilling, at every
 * budget level:
 *
 *     Available = Approved − Commitments − Actual
 *
 *   * Approved    — the sum of the budget's lines' `amount`.
 *   * Commitments — open reservations (invoices raised, payments scheduled,
 *     contracts, manual) that have not yet settled. A settled or cancelled
 *     commitment stops reserving budget.
 *   * Actual      — net posted spending on the budget's accounts within its
 *     period and dimension scope, derived live from JournalLine (debits −
 *     credits), so a reversal or credit automatically reduces actual spending.
 *
 * The committed/actual/available columns on Budget and BudgetLine are a cache
 * written by `recomputeAvailability`. They are never authoritative: every figure
 * here is recomputed from the source rows, so a stale cache can always be
 * rebuilt and can never silently drift. Recompute runs on every posting and on
 * every commitment change.
 */

/** Active commitment statuses — these reserve budget. */
const RESERVING_STATUSES = ['OPEN', 'PARTIALLY_SETTLED', 'OVERDUE'] as const;

export function ZERO(): Decimal {
  return new Decimal(0);
}

/** Coerce a Prisma Decimal / number / string / null into a Decimal. */
export function dec(value: Prisma.Decimal | number | string | null | undefined): Decimal {
  if (value === null || value === undefined) return ZERO();
  return value instanceof Decimal ? value : new Decimal(value);
}

interface BudgetScope {
  organizationId: string;
  currencyCode: string;
  startDate: Date;
  endDate: Date;
  projectId: string | null;
  departmentId: string | null;
  fundingSourceId: string | null;
  costCentreId: string | null;
}

/**
 * Journal dimension filter for a budget's scope.
 *
 * A dimensioned budget (project/department/funding/cost-centre) only counts
 * postings tagged with that dimension; a COMPANY budget applies to the account
 * as a whole. ACTIVITY-level budgets also apply account-wide: an activity label
 * has no journal dimension in Phase 1.
 */
function scopeWhere(budget: BudgetScope): Prisma.JournalLineWhereInput {
  return {
    ...(budget.projectId ? { projectId: budget.projectId } : {}),
    ...(budget.departmentId ? { departmentId: budget.departmentId } : {}),
    ...(budget.fundingSourceId ? { fundingSourceId: budget.fundingSourceId } : {}),
    ...(budget.costCentreId ? { costCentreId: budget.costCentreId } : {}),
  };
}

/**
 * Net actual spending on one account within a budget's period, currency and
 * dimension scope. Debits increase spend, credits (reversals/refunds) reduce it.
 */
async function lineActual(
  tx: Prisma.TransactionClient,
  budget: BudgetScope,
  accountId: string,
): Promise<Decimal> {
  const inclusiveEnd = new Date(budget.endDate);
  inclusiveEnd.setUTCHours(23, 59, 59, 999);
  const rows = await tx.journalLine.findMany({
    where: {
      organizationId: budget.organizationId,
      accountId,
      entry: {
        status: 'POSTED',
        OR: [
          { transaction: { is: { date: { gte: budget.startDate, lte: budget.endDate } } } },
          {
            transaction: { is: null },
            postedAt: { gte: budget.startDate, lte: inclusiveEnd },
          },
        ],
      },
      ...scopeWhere(budget),
    },
    select: {
      debit: true,
      credit: true,
      currencyCode: true,
      entry: { select: { postedAt: true, transaction: { select: { date: true } } } },
    },
  });

  let total = ZERO();
  for (const row of rows) {
    const nativeAmount = dec(row.debit).minus(dec(row.credit));
    const effectiveDate = row.entry.transaction?.date ?? row.entry.postedAt ?? budget.endDate;
    total = total.plus(
      await convertAmount(tx, nativeAmount, row.currencyCode, budget.currencyCode, effectiveDate),
    );
  }
  return total;
}

/** Reserved (unsettled) amount against one budget line. */
async function lineCommitted(tx: Prisma.TransactionClient, budgetLineId: string): Promise<Decimal> {
  const rows = await tx.commitment.findMany({
    where: { budgetLineId, status: { in: [...RESERVING_STATUSES] } },
    select: { amount: true },
  });
  return rows.reduce((sum, r) => sum.plus(dec(r.amount)), ZERO());
}

export interface LineAvailability {
  lineId: string;
  accountId: string;
  approved: Decimal;
  committed: Decimal;
  actual: Decimal;
  available: Decimal;
  isOverBudget: boolean;
}

export interface BudgetAvailability {
  budgetId: string;
  approved: Decimal;
  committed: Decimal;
  actual: Decimal;
  available: Decimal;
  isOverBudget: boolean;
  lines: LineAvailability[];
}

/**
 * Recomputes availability for every line of a budget and persists the cache on
 * both the lines and the budget header. Call inside the same transaction as the
 * posting or commitment change that invalidated it.
 *
 * Budget-level `committed` sums ALL reservations against the budget (including
 * any not yet linked to a line), while `actual` is the sum of the lines'
 * actuals (both derive from the same account set). Both are independent
 * recomputes so the header can never be a stale roll-up of stale lines.
 */
export async function recomputeAvailability(
  tx: Prisma.TransactionClient,
  budgetId: string,
): Promise<BudgetAvailability> {
  const budget = await tx.budget.findUnique({
    where: { id: budgetId },
    include: { lines: { orderBy: { createdAt: 'asc' } } },
  });

  if (!budget) {
    throw new NotFoundError('Budget', budgetId);
  }

  const scope: BudgetScope = {
    organizationId: budget.organizationId,
    currencyCode: budget.currencyCode,
    startDate: budget.startDate,
    endDate: budget.endDate,
    projectId: budget.projectId,
    departmentId: budget.departmentId,
    fundingSourceId: budget.fundingSourceId,
    costCentreId: budget.costCentreId,
  };

  const lines: LineAvailability[] = [];
  let approved = ZERO();
  let lineCommittedTotal = ZERO();
  let actual = ZERO();

  for (const line of budget.lines) {
    const committed = await lineCommitted(tx, line.id);
    const lineSpend = await lineActual(tx, scope, line.accountId);
    const available = dec(line.amount).minus(committed).minus(lineSpend);

    await tx.budgetLine.update({
      where: { id: line.id },
      data: {
        committedAmount: committed,
        actualAmount: lineSpend,
        availableAmount: available,
        isOverBudget: available.isNegative(),
      },
    });

    lines.push({
      lineId: line.id,
      accountId: line.accountId,
      approved: dec(line.amount),
      committed,
      actual: lineSpend,
      available,
      isOverBudget: available.isNegative(),
    });

    approved = approved.plus(dec(line.amount));
    lineCommittedTotal = lineCommittedTotal.plus(committed);
    actual = actual.plus(lineSpend);
  }

  // Reservations against the budget header with no matching line still hold
  // budget; counting them keeps the header honest even when a commitment names
  // an account the budget has no line for.
  const orphanRows = await tx.commitment.findMany({
    where: { budgetId: budget.id, budgetLineId: null, status: { in: [...RESERVING_STATUSES] } },
    select: { amount: true },
  });
  const committed = lineCommittedTotal.plus(
    orphanRows.reduce((s, r) => s.plus(dec(r.amount)), ZERO()),
  );

  const available = approved.minus(committed).minus(actual);
  const isOverBudget = available.isNegative();

  await tx.budget.update({
    where: { id: budget.id },
    data: {
      approvedAmount: approved,
      committedAmount: committed,
      actualAmount: actual,
      availableAmount: available,
      isOverBudget,
    },
  });

  return { budgetId: budget.id, approved, committed, actual, available, isOverBudget, lines };
}

export interface OverBudgetCheck {
  overBudget: boolean;
  /** Total available across every budget line the posting touches. */
  available: Decimal;
  /** available − the proposed amount. Negative means it does not fit. */
  projected: Decimal;
  /** The budget whose line is most constrained, for a useful error message. */
  budgetId: string | null;
}

/**
 * Over-budget guard at posting (M9 deliverable).
 *
 * For a proposed posting against an account, find every live budget that governs
 * that account within its period and dimension scope, compute its line's true
 * available, and report whether the proposed amount would push it negative. The
 * OVER_BUDGET approval condition calls this; when it returns `overBudget`, the
 * transaction routes to the CEO for approval before it can post.
 */
export async function evaluatePostingOverBudget(
  tx: Prisma.TransactionClient,
  params: {
    organizationId: string;
    accountId: string;
    amount: Decimal | number | string;
    currencyCode: string;
    asOf?: Date;
    projectId?: string | null;
    departmentId?: string | null;
    fundingSourceId?: string | null;
    costCentreId?: string | null;
  },
): Promise<OverBudgetCheck> {
  const asOf = params.asOf ?? new Date();

  const budgets = await tx.budget.findMany({
    where: {
      organizationId: params.organizationId,
      status: 'ACTIVE',
      startDate: { lte: asOf },
      endDate: { gte: asOf },
      lines: { some: { accountId: params.accountId } },
    },
    include: {
      lines: {
        where: { accountId: params.accountId },
        select: { id: true, amount: true, accountId: true },
      },
    },
  });

  let budgetId: string | null = null;
  let tightest: Decimal | null = null;
  let overBudget = false;
  let tightestProjected = ZERO();

  for (const budget of budgets) {
    // A dimensioned budget only governs postings carrying that exact dimension.
    if (budget.projectId && budget.projectId !== (params.projectId ?? null)) continue;
    if (budget.departmentId && budget.departmentId !== (params.departmentId ?? null)) continue;
    if (budget.fundingSourceId && budget.fundingSourceId !== (params.fundingSourceId ?? null)) continue;
    if (budget.costCentreId && budget.costCentreId !== (params.costCentreId ?? null)) continue;

    const scope: BudgetScope = {
      organizationId: budget.organizationId,
      currencyCode: budget.currencyCode,
      startDate: budget.startDate,
      endDate: budget.endDate,
      projectId: budget.projectId,
      departmentId: budget.departmentId,
      fundingSourceId: budget.fundingSourceId,
      costCentreId: budget.costCentreId,
    };

    for (const line of budget.lines) {
      const committed = await lineCommitted(tx, line.id);
      const spend = await lineActual(tx, scope, line.accountId);
      const available = dec(line.amount).minus(committed).minus(spend);
      const proposed = await convertAmount(
        tx,
        new Decimal(params.amount),
        params.currencyCode,
        budget.currencyCode,
        asOf,
      );
      const projected = available.minus(proposed);

      if (projected.isNegative()) overBudget = true;

      if (tightest === null || available.lessThan(tightest)) {
        tightest = available;
        tightestProjected = projected;
        budgetId = budget.id;
      }
    }
  }

  return {
    overBudget,
    available: tightest ?? ZERO(),
    projected: tightest === null ? ZERO() : tightestProjected,
    budgetId,
  };
}

async function convertAmount(
  tx: Prisma.TransactionClient,
  amount: Decimal,
  fromCurrency: string,
  toCurrency: string,
  asOf: Date,
): Promise<Decimal> {
  if (fromCurrency === toCurrency) return amount;

  const direct = await tx.exchangeRate.findFirst({
    where: {
      baseCurrency: { code: fromCurrency },
      quoteCurrency: { code: toCurrency },
      rateDate: { lte: asOf },
    },
    orderBy: { rateDate: 'desc' },
    select: { rate: true },
  });
  if (direct) return amount.times(dec(direct.rate));

  const inverse = await tx.exchangeRate.findFirst({
    where: {
      baseCurrency: { code: toCurrency },
      quoteCurrency: { code: fromCurrency },
      rateDate: { lte: asOf },
    },
    orderBy: { rateDate: 'desc' },
    select: { rate: true },
  });
  if (inverse && !dec(inverse.rate).isZero()) return amount.div(dec(inverse.rate));

  throw new ValidationError(
    `No exchange rate exists to compare ${fromCurrency} posting against a ${toCurrency} budget.`,
    { fromCurrency, toCurrency, asOf: asOf.toISOString() },
  );
}

/**
 * Enforces the configured restrictions on a restricted funding source for an
 * expense. The seeded restrictions use project codes and the three documented
 * cost-category labels; unknown expense subcategories fail closed.
 */
export async function validateRestrictedFundingExpense(
  tx: Prisma.TransactionClient,
  params: {
    organizationId: string;
    accountId: string;
    fundingSourceId: string | null;
    projectId: string | null;
  },
): Promise<void> {
  if (!params.fundingSourceId) return;

  const fundingSource = await tx.fundingSource.findFirst({
    where: { id: params.fundingSourceId, organizationId: params.organizationId },
    select: { isRestricted: true, restrictions: true, code: true },
  });
  if (!fundingSource?.isRestricted) return;

  const account = await tx.account.findFirst({
    where: { id: params.accountId, organizationId: params.organizationId },
    select: { type: true, subCategory: true },
  });
  if (!account || account.type !== 'EXPENSE') return;

  const restrictions = fundingSource.restrictions;
  if (!restrictions || typeof restrictions !== 'object' || Array.isArray(restrictions)) {
    throw new ValidationError(
      `Restricted funding source ${fundingSource.code} has no usable eligibility rules.`,
      { fundingSourceId: params.fundingSourceId },
    );
  }

  const allowedProjects = readStringArray(restrictions, 'allowedProjects');
  if (allowedProjects !== null) {
    if (!params.projectId) {
      throw new ValidationError(`Restricted funding source ${fundingSource.code} requires an eligible project.`);
    }
    const project = await tx.project.findFirst({
      where: { id: params.projectId, organizationId: params.organizationId },
      select: { code: true },
    });
    if (!project || !allowedProjects.includes(project.code)) {
      throw new ValidationError(
        `Project is not eligible for restricted funding source ${fundingSource.code}.`,
        { fundingSourceId: params.fundingSourceId, projectId: params.projectId },
      );
    }
  }

  const allowedCostCategories = readStringArray(restrictions, 'allowedCostCategories');
  if (allowedCostCategories !== null) {
    const category = account.subCategory === 'EXPENSE_SALARIES'
      ? 'PERSONNEL'
      : account.subCategory === 'EXPENSE_HARDWARE_PROTOTYPING'
        ? 'EQUIPMENT'
        : account.subCategory === 'EXPENSE_TRANSPORT'
          ? 'TRAVEL'
          : null;
    if (!category || !allowedCostCategories.includes(category)) {
      throw new ValidationError(
        `Expense account is not eligible for restricted funding source ${fundingSource.code}.`,
        { fundingSourceId: params.fundingSourceId, accountSubCategory: account.subCategory },
      );
    }
  }
}

function readStringArray(
  value: Prisma.JsonObject,
  key: string,
): string[] | null {
  const raw = value[key];
  if (!Array.isArray(raw)) return null;
  return raw.filter((item): item is string => typeof item === 'string');
}

