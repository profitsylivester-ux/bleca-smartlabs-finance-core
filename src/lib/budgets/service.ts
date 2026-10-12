import {
  Prisma,
  type BudgetLevel,
  type BudgetStatus,
  type CommitmentStatus,
} from '@/generated/prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import type { AuditActor } from '@/lib/audit/types';
import { writeAuditEntry } from '@/lib/audit/writer';
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '@/lib/kernel/errors';
import { recomputeAvailability, dec, ZERO } from './availability';
import type { BudgetAvailability } from './availability';

/**
 * Budget lifecycle, revisions, transfers, commitments and scenarios (M9,
 * PDF §13 + §67).
 *
 * Every function takes `tx` rather than the global client, so the business
 * mutation, the availability recompute and the audit write all land in one
 * transaction or none of them do (PHASE_1_PLAN.md 7.4). Availability is never
 * trusted from the cache — it is recomputed from source rows by
 * `recomputeAvailability` after every change that can move it: a posting, a
 * commitment, a line edit, a revision approval and a transfer application.
 *
 * Approval gating: budget revisions and transfers are created in a draft state
 * and only mutate the real budget lines when approved. The over-budget guard at
 * posting lives in `evaluatePostingOverBudget` (availability.ts) and is wired to
 * the OVER_BUDGET approval condition so an over-budget transaction routes to the
 * CEO before it can post.
 */

export type BudgetActor = AuditActor;

/** Statuses in which a budget's lines may still be edited directly. */
const MUTABLE_STATUSES = new Set<string>(['DRAFT', 'SUBMITTED', 'APPROVED']);

function requireLineAmount(amount: Decimal): void {
  if (amount.isNegative() || amount.isZero()) {
    throw new ValidationError('Budget line amounts must be greater than zero.');
  }
}

/** Validates the schema's documented monthly phasing shape and exact total. */
function validatePhasing(
  phasing: unknown,
  amount: Decimal,
  periodType: string,
): void {
  if (phasing === null || phasing === undefined) return;
  if (periodType !== 'MONTHLY') {
    throw new ValidationError('Monthly phasing can only be supplied for a MONTHLY budget.');
  }
  if (typeof phasing !== 'object' || Array.isArray(phasing)) {
    throw new ValidationError('Budget line phasing must be an object keyed by month number.');
  }

  const entries = Object.entries(phasing);
  if (entries.length === 0) {
    throw new ValidationError('Budget line phasing must include at least one month.');
  }

  let total = ZERO();
  for (const [month, rawAmount] of entries) {
    if (!/^(?:[1-9]|1[0-2])$/.test(month)) {
      throw new ValidationError(`Budget line phasing month ${month} must be between 1 and 12.`);
    }
    if (typeof rawAmount !== 'number' && typeof rawAmount !== 'string') {
      throw new ValidationError(`Budget line phasing for month ${month} must be a decimal amount.`);
    }
    if (typeof rawAmount === 'number' && (!Number.isFinite(rawAmount) || rawAmount < 0)) {
      throw new ValidationError(`Budget line phasing for month ${month} must be a non-negative amount.`);
    }
    if (typeof rawAmount === 'string' && !/^\d+(\.\d{1,6})?$/.test(rawAmount)) {
      throw new ValidationError(`Budget line phasing for month ${month} must be a non-negative amount with at most six decimals.`);
    }
    total = total.plus(new Decimal(rawAmount));
  }

  if (!total.equals(amount)) {
    throw new ValidationError('Monthly phasing amounts must sum exactly to the budget line amount.', {
      phasedAmount: total.toString(),
      lineAmount: amount.toString(),
    });
  }
}

function phasingInput(value: Prisma.InputJsonValue | null | undefined) {
  if (value === undefined) return undefined;
  return value === null ? Prisma.JsonNull : value;
}

/**
 * Enforces that a budget carries exactly the dimension its level implies
 * (PDF §13: budgets exist at company, department, project, funding-restricted
 * and activity levels). A COMPANY budget is unscoped; every other level must
 * name its matching dimension. `costCentre` is an optional orthogonal refinement
 * and is allowed at any level.
 */
function validateScope(
  type: string,
  dims: {
    projectId?: string | null;
    departmentId?: string | null;
    fundingSourceId?: string | null;
    activity?: string | null;
  },
): void {
  const {
    projectId = null,
    departmentId = null,
    fundingSourceId = null,
    activity = null,
  } = dims;
  const scopedDimensions = [projectId, departmentId, fundingSourceId, activity].filter(Boolean);

  if (type === 'COMPANY') {
    if (scopedDimensions.length > 0) {
      throw new ValidationError(
        'A COMPANY budget is org-wide and must not name a project, department, funding source or activity.',
      );
    }
    return;
  }

  if (scopedDimensions.length !== 1) {
    throw new ValidationError('A dimensioned budget must name exactly one matching scope.');
  }

  if (type === 'PROJECT' && !projectId) {
    throw new ValidationError('A PROJECT budget must name a project.');
  }
  if (type === 'DEPARTMENT' && !departmentId) {
    throw new ValidationError('A DEPARTMENT budget must name a department.');
  }
  if (type === 'FUNDING' && !fundingSourceId) {
    throw new ValidationError('A FUNDING budget must name a funding source.');
  }
  if (type === 'ACTIVITY' && !activity) {
    throw new ValidationError('An ACTIVITY budget must name an activity.');
  }
}

async function validateBudgetReferences(
  tx: Prisma.TransactionClient,
  organizationId: string,
  input: Pick<CreateBudgetInput,
    'currencyCode' | 'projectId' | 'departmentId' | 'fundingSourceId' | 'costCentreId' | 'lines'>,
): Promise<void> {
  const currency = await tx.currency.findFirst({
    where: { code: input.currencyCode, isActive: true },
    select: { code: true },
  });
  if (!currency) throw new ValidationError(`Currency ${input.currencyCode} is not active.`);

  const accounts = await tx.account.findMany({
    where: {
      organizationId,
      id: { in: [...new Set(input.lines.map((line) => line.accountId))] },
    },
    select: { id: true },
  });
  if (accounts.length !== new Set(input.lines.map((line) => line.accountId)).size) {
    throw new ValidationError('Every budget line account must belong to the current organization.');
  }

  if (input.projectId && !(await tx.project.findFirst({
    where: { id: input.projectId, organizationId }, select: { id: true },
  }))) throw new ValidationError('projectId must refer to a record in the current organization.');
  if (input.departmentId && !(await tx.department.findFirst({
    where: { id: input.departmentId, organizationId }, select: { id: true },
  }))) throw new ValidationError('departmentId must refer to a record in the current organization.');
  if (input.fundingSourceId && !(await tx.fundingSource.findFirst({
    where: { id: input.fundingSourceId, organizationId }, select: { id: true },
  }))) throw new ValidationError('fundingSourceId must refer to a record in the current organization.');
  if (input.costCentreId && !(await tx.costCentre.findFirst({
    where: { id: input.costCentreId, organizationId }, select: { id: true },
  }))) throw new ValidationError('costCentreId must refer to a record in the current organization.');
}

/**
 * Recomputes a budget's availability, then writes one audit entry recording the
 * new figures. Used after every change that moves availability so the trail can
 * show what the available balance became and when.
 */
export async function recomputeAndAudit(
  tx: Prisma.TransactionClient,
  budgetId: string,
  actor: BudgetActor,
  context: string,
): Promise<BudgetAvailability> {
  const avail = await recomputeAvailability(tx, budgetId);

  const budget = await tx.budget.findUnique({
    where: { id: budgetId },
    select: { code: true, name: true, organizationId: true },
  });

  await writeAuditEntry(
    tx,
    { id: actor.id, name: actor.name, roleCodes: actor.roleCodes },
    {
      action: 'BUDGET_AVAILABILITY_RECOMPUTED',
      entityType: 'BUDGET',
      entityId: budgetId,
      entityLabel: budget ? `${budget.code} ${budget.name}` : budgetId,
      description: `Recomputed availability for budget ${budgetId} — ${context}`,
      metadata: {
        approved: avail.approved.toString(),
        committed: avail.committed.toString(),
        actual: avail.actual.toString(),
        available: avail.available.toString(),
        isOverBudget: avail.isOverBudget,
        context,
      },
    },
    { organizationId: budget?.organizationId ?? null },
  );

  return avail;
}

export interface CreateBudgetInput {
  organizationId: string;
  code: string;
  name: string;
  description?: string | null;
  type: 'COMPANY' | 'DEPARTMENT' | 'PROJECT' | 'FUNDING' | 'ACTIVITY';
  periodType: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
  startDate: Date;
  endDate: Date;
  currencyCode: string;
  projectId?: string | null;
  departmentId?: string | null;
  fundingSourceId?: string | null;
  costCentreId?: string | null;
  activity?: string | null;
  createdById?: string | null;
  lines: Array<{
    accountId: string;
    amount: number | string;
    description?: string | null;
    phasing?: Prisma.InputJsonValue | null;
  }>;
}

/**
 * Creates a DRAFT budget with its lines, then seeds availability. The budget is
 * not active until it is approved and activated, so it holds no real budget
 * until then.
 */
export async function createBudget(
  tx: Prisma.TransactionClient,
  input: CreateBudgetInput,
  actor: BudgetActor,
): Promise<{ id: string; code: string; status: string }> {
  validateScope(input.type, input);

  if (input.endDate < input.startDate) {
    throw new ValidationError('Budget end date must be on or after the start date.');
  }

  const existing = await tx.budget.findFirst({
    where: { organizationId: input.organizationId, code: input.code },
    select: { id: true },
  });
  if (existing) {
    throw new ConflictError(`A budget with code ${input.code} already exists.`, { code: input.code });
  }

  if (input.lines.length === 0) {
    throw new ValidationError('A budget must have at least one line.');
  }

  const seen = new Set<string>();
  for (const line of input.lines) {
    const amount = dec(line.amount);
    requireLineAmount(amount);
    validatePhasing(line.phasing, amount, input.periodType);
    if (seen.has(line.accountId)) {
      throw new ValidationError('A budget cannot have two lines for the same account.', {
        accountId: line.accountId,
      });
    }
    seen.add(line.accountId);
  }

  await validateBudgetReferences(tx, input.organizationId, input);

  const budget = await tx.budget.create({
    data: {
      organizationId: input.organizationId,
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      type: input.type,
      status: 'DRAFT',
      periodType: input.periodType,
      startDate: input.startDate,
      endDate: input.endDate,
      currencyCode: input.currencyCode,
      projectId: input.projectId ?? null,
      departmentId: input.departmentId ?? null,
      fundingSourceId: input.fundingSourceId ?? null,
      costCentreId: input.costCentreId ?? null,
      activity: input.activity ?? null,
      createdById: input.createdById ?? null,
      lines: {
        create: input.lines.map((l) => ({
          organizationId: input.organizationId,
          accountId: l.accountId,
          amount: dec(l.amount),
          description: l.description ?? null,
          phasing: phasingInput(l.phasing),
        })),
      },
    },
    select: { id: true, code: true, status: true },
  });

  await recomputeAndAudit(tx, budget.id, actor, 'budget created');

  await writeAuditEntry(
    tx,
    { id: actor.id, name: actor.name, roleCodes: actor.roleCodes },
    {
      action: 'BUDGET_CREATED',
      entityType: 'BUDGET',
      entityId: budget.id,
      entityLabel: input.code,
      description: `Created ${input.type} budget ${input.code} (${input.name})`,
      changes: {
        code: { from: null, to: input.code },
        name: { from: null, to: input.name },
        type: { from: null, to: input.type },
        status: { from: null, to: 'DRAFT' },
      },
      metadata: { level: input.type, lineCount: input.lines.length, currency: input.currencyCode },
    },
    { organizationId: input.organizationId },
  );

  return budget;
}


async function getBudgetOrThrow(
  tx: Prisma.TransactionClient,
  budgetId: string,
  organizationId: string,
) {
  const budget = await tx.budget.findFirst({
    where: { id: budgetId, organizationId },
    select: {
      id: true,
      code: true,
      name: true,
      description: true,
      status: true,
      type: true,
      periodType: true,
      startDate: true,
      endDate: true,
      projectId: true,
      departmentId: true,
      fundingSourceId: true,
      costCentreId: true,
      activity: true,
      currencyCode: true,
      createdById: true,
      approvedById: true,
      approvedAt: true,
      activatedAt: true,
      closedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!budget) throw new NotFoundError('Budget', budgetId);
  return budget;
}

export interface UpdateBudgetInput {
  code?: string;
  name?: string;
  description?: string | null;
  periodType?: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
  startDate?: Date;
  endDate?: Date;
  projectId?: string | null;
  departmentId?: string | null;
  fundingSourceId?: string | null;
  costCentreId?: string | null;
  activity?: string | null;
}

export async function updateBudget(
  tx: Prisma.TransactionClient,
  budgetId: string,
  organizationId: string,
  input: UpdateBudgetInput,
  actor: BudgetActor,
): Promise<{ id: string; code: string; status: string }> {
  const current = await getBudgetOrThrow(tx, budgetId, organizationId);
  assertStatus(current, ['DRAFT'], 'edit');

  const startDate = input.startDate ?? current.startDate;
  const endDate = input.endDate ?? current.endDate;
  const periodType = input.periodType ?? current.periodType;
  if (endDate < startDate) {
    throw new ValidationError('Budget end date must be on or after the start date.');
  }

  const existingLines = await tx.budgetLine.findMany({
    where: { budgetId: current.id },
    select: { amount: true, phasing: true },
  });
  for (const line of existingLines) {
    validatePhasing(line.phasing, dec(line.amount), periodType);
  }

  const scope = {
    projectId: input.projectId === undefined ? current.projectId : input.projectId,
    departmentId: input.departmentId === undefined ? current.departmentId : input.departmentId,
    fundingSourceId: input.fundingSourceId === undefined ? current.fundingSourceId : input.fundingSourceId,
    activity: input.activity === undefined ? current.activity : input.activity,
  };
  validateScope(current.type, scope);

  for (const [field, id] of [
    ['projectId', scope.projectId],
    ['departmentId', scope.departmentId],
    ['fundingSourceId', scope.fundingSourceId],
    ['costCentreId', input.costCentreId === undefined ? current.costCentreId : input.costCentreId],
  ] as const) {
    if (!id) continue;
    const belongsToOrganization = field === 'projectId'
      ? await tx.project.findFirst({ where: { id, organizationId }, select: { id: true } })
      : field === 'departmentId'
        ? await tx.department.findFirst({ where: { id, organizationId }, select: { id: true } })
        : field === 'fundingSourceId'
          ? await tx.fundingSource.findFirst({ where: { id, organizationId }, select: { id: true } })
          : await tx.costCentre.findFirst({ where: { id, organizationId }, select: { id: true } });
    if (!belongsToOrganization) {
      throw new ValidationError(`${field} must refer to a record in the current organization.`);
    }
  }

  const updated = await tx.budget.update({
    where: { id: current.id },
    data: {
      code: input.code,
      name: input.name,
      description: input.description,
      periodType: input.periodType,
      startDate: input.startDate,
      endDate: input.endDate,
      projectId: input.projectId,
      departmentId: input.departmentId,
      fundingSourceId: input.fundingSourceId,
      costCentreId: input.costCentreId,
      activity: input.activity,
    },
    select: { id: true, code: true, status: true },
  });

  await recomputeAndAudit(tx, current.id, actor, 'budget details updated');
  await writeAuditEntry(
    tx,
    { id: actor.id, name: actor.name, roleCodes: actor.roleCodes },
    {
      action: 'BUDGET_UPDATED',
      entityType: 'BUDGET',
      entityId: current.id,
      entityLabel: updated.code,
      description: `Updated draft budget ${updated.code}`,
      metadata: {
        changedFields: Object.keys(input),
      },
    },
    { organizationId },
  );

  return updated;
}

function assertStatus(
  budget: { status: string; code?: string },
  expected: readonly string[],
  action: string,
) {
  if (!expected.includes(budget.status)) {
    const label = budget.code ? `budget ${budget.code}` : 'record';
    throw new ConflictError(
      `Cannot ${action} ${label} while it is ${budget.status}. Expected one of: ${expected.join(', ')}.`,
      { status: budget.status },
    );
  }
}

/** DRAFT → SUBMITTED. */
export async function submitBudget(
  tx: Prisma.TransactionClient,
  budgetId: string,
  organizationId: string,
  actor: BudgetActor,
): Promise<{ id: string; status: string }> {
  const budget = await getBudgetOrThrow(tx, budgetId, organizationId);
  assertStatus(budget, ['DRAFT', 'REJECTED'], 'submit');

  const updated = await tx.budget.update({
    where: { id: budget.id },
    data: { status: 'SUBMITTED' },
    select: { id: true, status: true },
  });

  await writeAuditEntry(
    tx,
    { id: actor.id, name: actor.name, roleCodes: actor.roleCodes },
    {
      action: 'BUDGET_SUBMITTED',
      entityType: 'BUDGET',
      entityId: budget.id,
      entityLabel: budget.code,
      description: `Submitted budget ${budget.code} for approval`,
      changes: { status: { from: budget.status, to: 'SUBMITTED' } },
    },
    { organizationId },
  );

  return updated;
}


/** SUBMITTED → APPROVED. Approval is a CEO action and is recorded on the budget. */
export async function approveBudget(
  tx: Prisma.TransactionClient,
  budgetId: string,
  organizationId: string,
  actor: BudgetActor,
): Promise<{ id: string; status: string }> {
  const budget = await getBudgetOrThrow(tx, budgetId, organizationId);
  assertStatus(budget, ['SUBMITTED'], 'approve');
  if (actor.id && budget.createdById === actor.id) {
    throw new AuthorizationError('A budget preparer cannot approve their own budget.');
  }

  const updated = await tx.budget.update({
    where: { id: budget.id },
    data: { status: 'APPROVED', approvedById: actor.id, approvedAt: new Date() },
    select: { id: true, status: true },
  });

  await writeAuditEntry(
    tx,
    { id: actor.id, name: actor.name, roleCodes: actor.roleCodes },
    {
      action: 'BUDGET_APPROVED',
      entityType: 'BUDGET',
      entityId: budget.id,
      entityLabel: budget.code,
      description: `Approved budget ${budget.code}`,
      changes: { status: { from: 'SUBMITTED', to: 'APPROVED' } },
    },
    { organizationId },
  );

  return updated;
}

/** SUBMITTED → REJECTED. */
export async function rejectBudget(
  tx: Prisma.TransactionClient,
  budgetId: string,
  organizationId: string,
  actor: BudgetActor,
): Promise<{ id: string; status: string }> {
  const budget = await getBudgetOrThrow(tx, budgetId, organizationId);
  assertStatus(budget, ['SUBMITTED'], 'reject');

  const updated = await tx.budget.update({
    where: { id: budget.id },
    data: { status: 'REJECTED' },
    select: { id: true, status: true },
  });

  await writeAuditEntry(
    tx,
    { id: actor.id, name: actor.name, roleCodes: actor.roleCodes },
    {
      action: 'BUDGET_REJECTED',
      entityType: 'BUDGET',
      entityId: budget.id,
      entityLabel: budget.code,
      description: `Rejected budget ${budget.code}`,
      changes: { status: { from: 'SUBMITTED', to: 'REJECTED' } },
    },
    { organizationId },
  );

  return updated;
}

/**
 * APPROVED → ACTIVE. Only an active budget governs new spending in the
 * over-budget guard.
 */
export async function activateBudget(
  tx: Prisma.TransactionClient,
  budgetId: string,
  organizationId: string,
  actor: BudgetActor,
): Promise<{ id: string; status: string }> {
  const budget = await getBudgetOrThrow(tx, budgetId, organizationId);
  assertStatus(budget, ['APPROVED'], 'activate');

  const updated = await tx.budget.update({
    where: { id: budget.id },
    data: { status: 'ACTIVE', activatedAt: new Date() },
    select: { id: true, status: true },
  });

  await writeAuditEntry(
    tx,
    { id: actor.id, name: actor.name, roleCodes: actor.roleCodes },
    {
      action: 'BUDGET_ACTIVATED',
      entityType: 'BUDGET',
      entityId: budget.id,
      entityLabel: budget.code,
      description: `Activated budget ${budget.code}`,
      changes: { status: { from: 'APPROVED', to: 'ACTIVE' } },
    },
    { organizationId },
  );

  return updated;
}

/** ACTIVE → CLOSED. A closed budget stops governing new postings. */
export async function closeBudget(
  tx: Prisma.TransactionClient,
  budgetId: string,
  organizationId: string,
  actor: BudgetActor,
): Promise<{ id: string; status: string }> {
  const budget = await getBudgetOrThrow(tx, budgetId, organizationId);
  assertStatus(budget, ['ACTIVE'], 'close');

  const updated = await tx.budget.update({
    where: { id: budget.id },
    data: { status: 'CLOSED', closedAt: new Date() },
    select: { id: true, status: true },
  });

  await writeAuditEntry(
    tx,
    { id: actor.id, name: actor.name, roleCodes: actor.roleCodes },
    {
      action: 'BUDGET_CLOSED',
      entityType: 'BUDGET',
      entityId: budget.id,
      entityLabel: budget.code,
      description: `Closed budget ${budget.code}`,
      changes: { status: { from: 'ACTIVE', to: 'CLOSED' } },
    },
    { organizationId },
  );

  return updated;
}


/**
 * Upserts a budget's lines while the budget is still mutable.
 * Each line's availability is recomputed afterwards so the cache reflects the
 * new approved amounts immediately.
 */
export async function upsertBudgetLines(
  tx: Prisma.TransactionClient,
  budgetId: string,
  organizationId: string,
  lines: Array<{
    accountId: string;
    amount: number | string;
    description?: string | null;
    phasing?: Prisma.InputJsonValue | null;
  }>,
  actor: BudgetActor,
): Promise<{ id: string; code: string }> {
  const budget = await getBudgetOrThrow(tx, budgetId, organizationId);
  if (!MUTABLE_STATUSES.has(budget.status)) {
    throw new ConflictError(
      `Cannot edit lines of budget ${budget.code} while it is ${budget.status}.`,
      { status: budget.status },
    );
  }

  const seen = new Set<string>();
  for (const line of lines) {
    const amount = dec(line.amount);
    requireLineAmount(amount);
    validatePhasing(line.phasing, amount, budget.periodType);
    if (seen.has(line.accountId)) {
      throw new ValidationError('A budget cannot have two lines for the same account.', {
        accountId: line.accountId,
      });
    }
    seen.add(line.accountId);
  }

  const accounts = await tx.account.findMany({
    where: {
      organizationId,
      id: { in: [...seen] },
    },
    select: { id: true },
  });
  if (accounts.length !== seen.size) {
    throw new ValidationError('Every budget line account must belong to the current organization.');
  }

  for (const line of lines) {
    const amount = dec(line.amount);
    await tx.budgetLine.upsert({
      where: { budgetId_accountId: { budgetId, accountId: line.accountId } },
      create: {
        organizationId,
        budgetId,
        accountId: line.accountId,
        amount,
        description: line.description ?? null,
        phasing: phasingInput(line.phasing),
      },
      update: {
        amount,
        description: line.description ?? null,
        phasing: phasingInput(line.phasing),
      },
    });

    await writeAuditEntry(
      tx,
      { id: actor.id, name: actor.name, roleCodes: actor.roleCodes },
      {
        action: 'BUDGET_LINE_UPDATED',
        entityType: 'BUDGET_LINE',
        entityId: line.accountId,
        entityLabel: budget.code,
        description: `Set budget line ${line.accountId} to ${amount.toString()} on ${budget.code}`,
        metadata: { budgetId, accountId: line.accountId, amount: amount.toString() },
      },
      { organizationId },
    );
  }

  await recomputeAndAudit(tx, budget.id, actor, 'lines updated');

  return { id: budget.id, code: budget.code };
}


export interface CreateRevisionInput {
  budgetId: string;
  organizationId: string;
  reason: string;
  /** proposed new amounts keyed by existing budgetLineId. */
  changes: Array<{ budgetLineId: string; afterAmount: number | string }>;
}

/**
 * Creates a DRAFT revision with a line-level before/after snapshot. It does NOT
 * touch the live budget lines — those change only when the revision is approved
 * (approveRevision). This preserves the full history of every change.
 */
export async function createRevision(
  tx: Prisma.TransactionClient,
  input: CreateRevisionInput,
  actor: BudgetActor,
): Promise<{ id: string; revisionNumber: number; status: string }> {
  const budget = await getBudgetOrThrow(tx, input.budgetId, input.organizationId);
  assertStatus(budget, ['DRAFT', 'APPROVED', 'ACTIVE'], 'revise');

  if (input.changes.length === 0) {
    throw new ValidationError('A revision must change at least one line.');
  }

  const lastRevision = await tx.budgetRevision.findFirst({
    where: { budgetId: budget.id },
    orderBy: { revisionNumber: 'desc' },
    select: { revisionNumber: true },
  });
  const revisionNumber = (lastRevision?.revisionNumber ?? 0) + 1;

  const lineIds = input.changes.map((c) => c.budgetLineId);
  const currentLines = await tx.budgetLine.findMany({
    where: { id: { in: lineIds }, budgetId: budget.id },
    select: { id: true, accountId: true, amount: true },
  });
  const byId = new Map(currentLines.map((l) => [l.id, l]));

  for (const change of input.changes) {
    const line = byId.get(change.budgetLineId);
    if (!line) {
      throw new NotFoundError('Budget line', change.budgetLineId);
    }
    const after = dec(change.afterAmount);
    if (after.isNegative()) {
      throw new ValidationError('Revised amounts cannot be negative.', {
        budgetLineId: change.budgetLineId,
      });
    }
  }

  const revision = await tx.budgetRevision.create({
    data: {
      organizationId: input.organizationId,
      budgetId: budget.id,
      revisionNumber,
      reason: input.reason,
      status: 'DRAFT',
      createdById: actor.id,
      lines: {
        create: input.changes.map((change) => {
          const line = byId.get(change.budgetLineId)!;
          return {
            organizationId: input.organizationId,
            budgetLineId: line.id,
            accountId: line.accountId,
            beforeAmount: dec(line.amount),
            afterAmount: dec(change.afterAmount),
          };
        }),
      },
    },
    select: { id: true, revisionNumber: true, status: true },
  });

  await writeAuditEntry(
    tx,
    { id: actor.id, name: actor.name, roleCodes: actor.roleCodes },
    {
      action: 'BUDGET_REVISION_CREATED',
      entityType: 'BUDGET_REVISION',
      entityId: revision.id,
      entityLabel: `${budget.code} rev ${revisionNumber}`,
      description: `Created revision ${revisionNumber} for budget ${budget.code}: ${input.reason}`,
      metadata: {
        budgetId: budget.id,
        revisionNumber,
        reason: input.reason,
        changes: input.changes.map((c) => ({
          budgetLineId: c.budgetLineId,
          before: byId.get(c.budgetLineId)!.amount.toString(),
          after: dec(c.afterAmount).toString(),
        })),
      },
    },
    { organizationId: input.organizationId },
  );

  return revision;
}


/**
 * Applies a DRAFT revision: moves each snapshot's `afterAmount` onto the live
 * budget line, marks the revision APPROVED and recomputes availability. The
 * before/after snapshots on the revision are left untouched as the permanent
 * record of what changed.
 */
export async function approveRevision(
  tx: Prisma.TransactionClient,
  revisionId: string,
  organizationId: string,
  actor: BudgetActor,
): Promise<{ id: string; status: string; budgetId: string }> {
  const revision = await tx.budgetRevision.findFirst({
    where: { id: revisionId, organizationId },
    include: { lines: true, budget: { select: { code: true, status: true } } },
  });
  if (!revision) throw new NotFoundError('Budget revision', revisionId);
  assertStatus(revision, ['DRAFT'], 'approve');
  if (actor.id && revision.createdById === actor.id) {
    throw new AuthorizationError('A revision preparer cannot approve their own revision.');
  }

  for (const line of revision.lines) {
    await tx.budgetLine.update({
      where: { id: line.budgetLineId },
      data: { amount: line.afterAmount },
    });
  }

  const updated = await tx.budgetRevision.update({
    where: { id: revision.id },
    data: { status: 'APPROVED', approvedById: actor.id, approvedAt: new Date() },
    select: { id: true, status: true, budgetId: true },
  });

  await writeAuditEntry(
    tx,
    { id: actor.id, name: actor.name, roleCodes: actor.roleCodes },
    {
      action: 'BUDGET_REVISION_APPROVED',
      entityType: 'BUDGET_REVISION',
      entityId: revision.id,
      entityLabel: `${revision.budget.code} rev ${revision.revisionNumber}`,
      description: `Approved revision ${revision.revisionNumber} for budget ${revision.budget.code}`,
      changes: { status: { from: 'DRAFT', to: 'APPROVED' } },
      metadata: {
        budgetId: revision.budgetId,
        revisionNumber: revision.revisionNumber,
        applied: revision.lines.map((l) => ({
          budgetLineId: l.budgetLineId,
          before: l.beforeAmount.toString(),
          after: l.afterAmount.toString(),
        })),
      },
    },
    { organizationId },
  );

  await recomputeAndAudit(tx, revision.budgetId, actor, `revision ${revision.revisionNumber} approved`);

  return updated;
}

/** Marks a DRAFT revision REJECTED without changing any live line. */
export async function rejectRevision(
  tx: Prisma.TransactionClient,
  revisionId: string,
  organizationId: string,
  actor: BudgetActor,
): Promise<{ id: string; status: string; budgetId: string }> {
  const revision = await tx.budgetRevision.findFirst({
    where: { id: revisionId, organizationId },
    include: { budget: { select: { code: true } } },
  });
  if (!revision) throw new NotFoundError('Budget revision', revisionId);
  assertStatus(revision, ['DRAFT'], 'reject');

  const updated = await tx.budgetRevision.update({
    where: { id: revision.id },
    data: { status: 'REJECTED', rejectedAt: new Date() },
    select: { id: true, status: true, budgetId: true },
  });

  await writeAuditEntry(
    tx,
    { id: actor.id, name: actor.name, roleCodes: actor.roleCodes },
    {
      action: 'BUDGET_REVISION_REJECTED',
      entityType: 'BUDGET_REVISION',
      entityId: revision.id,
      entityLabel: `${revision.budget.code} rev ${revision.revisionNumber}`,
      description: `Rejected revision ${revision.revisionNumber} for budget ${revision.budget.code}`,
      changes: { status: { from: 'DRAFT', to: 'REJECTED' } },
    },
    { organizationId },
  );

  return updated;
}


export interface CreateTransferInput {
  budgetId: string;
  organizationId: string;
  fromLineId: string;
  toLineId: string;
  amount: number | string;
  reason: string;
}

/**
 * Creates a DRAFT transfer between two lines of the same budget. The amounts do
 * not move until the transfer is applied (approveTransfer); this keeps the
 * transfer approval-gated and auditable, matching the plan's "transfers are
 * approval-gated and audited" requirement.
 */
export async function createTransfer(
  tx: Prisma.TransactionClient,
  input: CreateTransferInput,
  actor: BudgetActor,
): Promise<{ id: string; transferNumber: number; status: string }> {
  const budget = await getBudgetOrThrow(tx, input.budgetId, input.organizationId);
  assertStatus(budget, ['DRAFT', 'APPROVED', 'ACTIVE'], 'transfer within');

  if (input.fromLineId === input.toLineId) {
    throw new ValidationError('A transfer must move money between two different lines.');
  }

  const amount = dec(input.amount);
  requireLineAmount(amount);

  const currentAvailability = await recomputeAvailability(tx, budget.id);
  const sourceAvailability = currentAvailability.lines.find((line) => line.lineId === input.fromLineId);
  const [fromLine, toLine] = await Promise.all([
    tx.budgetLine.findFirst({ where: { id: input.fromLineId, budgetId: budget.id }, select: { id: true, amount: true } }),
    tx.budgetLine.findFirst({ where: { id: input.toLineId, budgetId: budget.id }, select: { id: true, amount: true } }),
  ]);
  if (!fromLine) throw new NotFoundError('Budget line', input.fromLineId);
  if (!toLine) throw new NotFoundError('Budget line', input.toLineId);

  if (!sourceAvailability || amount.greaterThan(sourceAvailability.available)) {
    throw new ValidationError(
      `Cannot transfer ${amount.toString()}; the source line has only ${sourceAvailability?.available.toString() ?? '0'} available.`,
      { available: sourceAvailability?.available.toString() ?? '0' },
    );
  }

  const last = await tx.budgetTransfer.findFirst({
    where: { budgetId: budget.id },
    orderBy: { transferNumber: 'desc' },
    select: { transferNumber: true },
  });
  const transferNumber = (last?.transferNumber ?? 0) + 1;

  const transfer = await tx.budgetTransfer.create({
    data: {
      organizationId: input.organizationId,
      budgetId: budget.id,
      transferNumber,
      fromLineId: input.fromLineId,
      toLineId: input.toLineId,
      amount,
      reason: input.reason,
      status: 'DRAFT',
      createdById: actor.id,
    },
    select: { id: true, transferNumber: true, status: true },
  });

  await writeAuditEntry(
    tx,
    { id: actor.id, name: actor.name, roleCodes: actor.roleCodes },
    {
      action: 'BUDGET_TRANSFER_CREATED',
      entityType: 'BUDGET_TRANSFER',
      entityId: transfer.id,
      entityLabel: `${budget.code} transfer ${transferNumber}`,
      description: `Created transfer ${transferNumber} of ${amount.toString()} within budget ${budget.code}: ${input.reason}`,
      metadata: {
        budgetId: budget.id,
        fromLineId: input.fromLineId,
        toLineId: input.toLineId,
        amount: amount.toString(),
        reason: input.reason,
      },
    },
    { organizationId: input.organizationId },
  );

  return transfer;
}


/**
 * Approves and applies a DRAFT transfer: decrements the source line, increments
 * the destination line, marks the transfer APPROVED/applied, then recomputes
 * availability on the budget. Both line amounts move atomically with the audit
 * write, so a transfer can never half-apply.
 */
export async function approveTransfer(
  tx: Prisma.TransactionClient,
  transferId: string,
  organizationId: string,
  actor: BudgetActor,
): Promise<{ id: string; status: string; budgetId: string }> {
  const transfer = await tx.budgetTransfer.findFirst({
    where: { id: transferId, organizationId },
    include: { budget: { select: { code: true } } },
  });
  if (!transfer) throw new NotFoundError('Budget transfer', transferId);
  assertStatus(transfer, ['DRAFT'], 'approve');
  if (actor.id && transfer.createdById === actor.id) {
    throw new AuthorizationError('A transfer preparer cannot approve their own transfer.');
  }

  const amount = dec(transfer.amount);
  const currentAvailability = await recomputeAvailability(tx, transfer.budgetId);
  const sourceAvailability = currentAvailability.lines.find((line) => line.lineId === transfer.fromLineId);

  const fromLine = await tx.budgetLine.findUnique({ where: { id: transfer.fromLineId } });
  if (!fromLine) throw new NotFoundError('Budget line', transfer.fromLineId);
  if (!sourceAvailability || amount.greaterThan(sourceAvailability.available)) {
    throw new ValidationError(
      `Cannot apply transfer: the source line has only ${sourceAvailability?.available.toString() ?? '0'} available, less than ${amount.toString()}.`,
      { available: sourceAvailability?.available.toString() ?? '0' },
    );
  }

  await tx.budgetLine.update({
    where: { id: transfer.fromLineId },
    data: { amount: { decrement: amount } },
  });
  await tx.budgetLine.update({
    where: { id: transfer.toLineId },
    data: { amount: { increment: amount } },
  });

  const updated = await tx.budgetTransfer.update({
    where: { id: transfer.id },
    data: { status: 'APPROVED', approvedById: actor.id, approvedAt: new Date(), appliedAt: new Date() },
    select: { id: true, status: true, budgetId: true },
  });

  await writeAuditEntry(
    tx,
    { id: actor.id, name: actor.name, roleCodes: actor.roleCodes },
    {
      action: 'BUDGET_TRANSFER_APPROVED',
      entityType: 'BUDGET_TRANSFER',
      entityId: transfer.id,
      entityLabel: `${transfer.budget.code} transfer ${transfer.transferNumber}`,
      description: `Approved and applied transfer ${transfer.transferNumber} of ${amount.toString()} within budget ${transfer.budget.code}`,
      changes: { status: { from: 'DRAFT', to: 'APPROVED' } },
      metadata: {
        budgetId: transfer.budgetId,
        fromLineId: transfer.fromLineId,
        toLineId: transfer.toLineId,
        amount: amount.toString(),
      },
    },
    { organizationId },
  );

  await recomputeAndAudit(tx, transfer.budgetId, actor, `transfer ${transfer.transferNumber} applied`);

  return updated;
}


export interface CreateCommitmentInput {
  organizationId: string;
  budgetId?: string | null;
  budgetLineId?: string | null;
  accountId: string;
  source: 'INVOICE' | 'PURCHASE_COMMITMENT' | 'CONTRACT' | 'PAYMENT_SCHEDULE' | 'MANUAL';
  sourceId?: string | null;
  description?: string | null;
  amount: number | string;
  currencyCode: string;
  commitmentDate: Date;
  expectedDate?: Date | null;
  projectId?: string | null;
  departmentId?: string | null;
  fundingSourceId?: string | null;
  createdById?: string | null;
}

/**
 * Creates a commitment (an open reservation) and recomputes availability so the
 * reserved amount immediately reduces the budget's available balance. When a
 * budget line is supplied, the commitment is linked to it so line-level
 * availability reflects the reservation too.
 */
export async function createCommitment(
  tx: Prisma.TransactionClient,
  input: CreateCommitmentInput,
  actor: BudgetActor,
): Promise<{ id: string; status: string }> {
  const amount = dec(input.amount);
  requireLineAmount(amount);

  const account = await tx.account.findFirst({
    where: { id: input.accountId, organizationId: input.organizationId },
    select: { id: true },
  });
  if (!account) throw new NotFoundError('Account', input.accountId);

  let budgetId = input.budgetId ?? null;
  let budgetLineId = input.budgetLineId ?? null;
  if (!budgetId && !budgetLineId) {
    throw new ValidationError('A commitment must be linked to a budget or budget line to reserve funds.');
  }

  if (budgetLineId) {
    const line = await tx.budgetLine.findFirst({
      where: { id: budgetLineId, organizationId: input.organizationId },
      select: { id: true, budgetId: true, accountId: true },
    });
    if (!line) throw new NotFoundError('Budget line', budgetLineId);
    if (budgetId && line.budgetId !== budgetId) {
      throw new ValidationError('The budget line does not belong to the supplied budget.');
    }
    if (line.accountId !== input.accountId) {
      throw new ValidationError('The commitment account must match the budget line account.');
    }
    budgetId = line.budgetId;
  }

  if (!budgetId) {
    throw new ValidationError('A commitment must resolve to a budget.');
  }
  const budget = await getBudgetOrThrow(tx, budgetId, input.organizationId);
  if (budget.currencyCode !== input.currencyCode) {
    throw new ValidationError('The commitment currency must match the budget currency.');
  }
  if (input.commitmentDate < budget.startDate || input.commitmentDate > budget.endDate) {
    throw new ValidationError('The commitment date must fall within the budget period.');
  }
  if (!budgetLineId) {
    const line = await tx.budgetLine.findFirst({
      where: { budgetId: budget.id, accountId: input.accountId },
      select: { id: true },
    });
    if (!line) throw new ValidationError('The budget has no line for the commitment account.');
    budgetLineId = line.id;
  }

  const commitment = await tx.commitment.create({
    data: {
      organizationId: input.organizationId,
      budgetId,
      budgetLineId,
      accountId: input.accountId,
      source: input.source,
      sourceId: input.sourceId ?? null,
      description: input.description ?? null,
      amount,
      currencyCode: input.currencyCode,
      status: 'OPEN',
      commitmentDate: input.commitmentDate,
      expectedDate: input.expectedDate ?? null,
      projectId: input.projectId ?? null,
      departmentId: input.departmentId ?? null,
      fundingSourceId: input.fundingSourceId ?? null,
      createdById: input.createdById ?? null,
    },
    select: { id: true, status: true, budgetId: true },
  });

  await writeAuditEntry(
    tx,
    { id: actor.id, name: actor.name, roleCodes: actor.roleCodes },
    {
      action: 'COMMITMENT_CREATED',
      entityType: 'COMMITMENT',
      entityId: commitment.id,
      entityLabel: input.sourceId ?? input.accountId,
      description: `Created ${input.source} commitment of ${amount.toString()} reserving budget`,
      metadata: {
        budgetId,
        budgetLineId,
        accountId: input.accountId,
        amount: amount.toString(),
        source: input.source,
        sourceId: input.sourceId ?? null,
      },
    },
    { organizationId: input.organizationId },
  );

  await recomputeAndAudit(tx, budgetId, actor, 'commitment created');

  return commitment;
}


/**
 * Settles a commitment — it has now become actual spend, so it stops reserving
 * budget. Recomputes availability: the reservation is released and the posting
 * it became carries the actual figure instead, so the total hold on the budget
 * is unchanged at the moment of settlement (the commitment amount is replaced by
 * the posted amount).
 */
export async function settleCommitment(
  tx: Prisma.TransactionClient,
  commitmentId: string,
  organizationId: string,
  actor: BudgetActor,
): Promise<{ id: string; status: string }> {
  const commitment = await tx.commitment.findFirst({
    where: { id: commitmentId, organizationId },
    select: { id: true, status: true, budgetId: true, sourceId: true, amount: true },
  });
  if (!commitment) throw new NotFoundError('Commitment', commitmentId);
  if (!['OPEN', 'PARTIALLY_SETTLED', 'OVERDUE'].includes(commitment.status)) {
    throw new ConflictError(`Commitment is already ${commitment.status}.`, {
      status: commitment.status,
    });
  }

  const updated = await tx.commitment.update({
    where: { id: commitment.id },
    data: { status: 'SETTLED', settledAt: new Date(), releasedAt: new Date() },
    select: { id: true, status: true, budgetId: true },
  });

  await writeAuditEntry(
    tx,
    { id: actor.id, name: actor.name, roleCodes: actor.roleCodes },
    {
      action: 'COMMITMENT_SETTLED',
      entityType: 'COMMITMENT',
      entityId: commitment.id,
      entityLabel: commitment.sourceId ?? commitment.id,
      description: `Settled commitment of ${dec(commitment.amount).toString()} (reservation released)`,
      changes: { status: { from: commitment.status, to: 'SETTLED' } },
    },
    { organizationId },
  );

  if (commitment.budgetId) {
    await recomputeAndAudit(tx, commitment.budgetId, actor, 'commitment settled');
  }

  return updated;
}

/** Cancels a commitment — the reservation is released and no spend occurred. */
export async function cancelCommitment(
  tx: Prisma.TransactionClient,
  commitmentId: string,
  organizationId: string,
  actor: BudgetActor,
): Promise<{ id: string; status: string }> {
  const commitment = await tx.commitment.findFirst({
    where: { id: commitmentId, organizationId },
    select: { id: true, status: true, budgetId: true, sourceId: true, amount: true },
  });
  if (!commitment) throw new NotFoundError('Commitment', commitmentId);
  if (!['OPEN', 'PARTIALLY_SETTLED', 'OVERDUE'].includes(commitment.status)) {
    throw new ConflictError(`Commitment is already ${commitment.status}.`, {
      status: commitment.status,
    });
  }

  const updated = await tx.commitment.update({
    where: { id: commitment.id },
    data: { status: 'CANCELLED', releasedAt: new Date() },
    select: { id: true, status: true, budgetId: true },
  });

  await writeAuditEntry(
    tx,
    { id: actor.id, name: actor.name, roleCodes: actor.roleCodes },
    {
      action: 'COMMITMENT_CANCELLED',
      entityType: 'COMMITMENT',
      entityId: commitment.id,
      entityLabel: commitment.sourceId ?? commitment.id,
      description: `Cancelled commitment of ${dec(commitment.amount).toString()} (reservation released)`,
      changes: { status: { from: commitment.status, to: 'CANCELLED' } },
    },
    { organizationId },
  );

  if (commitment.budgetId) {
    await recomputeAndAudit(tx, commitment.budgetId, actor, 'commitment cancelled');
  }

  return updated;
}

export interface UpdateCommitmentInput {
  amount?: number | string;
  description?: string | null;
  expectedDate?: Date | null;
}

export async function updateCommitment(
  tx: Prisma.TransactionClient,
  commitmentId: string,
  organizationId: string,
  input: UpdateCommitmentInput,
  actor: BudgetActor,
): Promise<{ id: string; status: string; budgetId: string | null }> {
  const current = await tx.commitment.findFirst({
    where: { id: commitmentId, organizationId },
    select: { id: true, status: true, budgetId: true, amount: true, description: true, expectedDate: true },
  });
  if (!current) throw new NotFoundError('Commitment', commitmentId);
  if (!['OPEN', 'PARTIALLY_SETTLED', 'OVERDUE'].includes(current.status)) {
    throw new ConflictError(`Cannot edit a ${current.status} commitment.`, { status: current.status });
  }
  if (input.amount !== undefined) requireLineAmount(dec(input.amount));

  const updated = await tx.commitment.update({
    where: { id: current.id },
    data: {
      amount: input.amount === undefined ? undefined : dec(input.amount),
      description: input.description,
      expectedDate: input.expectedDate,
    },
    select: { id: true, status: true, budgetId: true, amount: true, description: true, expectedDate: true },
  });

  await writeAuditEntry(
    tx,
    { id: actor.id, name: actor.name, roleCodes: actor.roleCodes },
    {
      action: 'COMMITMENT_UPDATED',
      entityType: 'COMMITMENT',
      entityId: current.id,
      entityLabel: current.id,
      description: `Updated open commitment ${current.id}`,
      changes: input.amount === undefined
        ? {}
        : { amount: { from: current.amount.toString(), to: dec(input.amount).toString() } },
      metadata: {
        changedFields: Object.keys(input),
        expectedDate: updated.expectedDate?.toISOString() ?? null,
      },
    },
    { organizationId },
  );

  if (updated.budgetId) {
    await recomputeAndAudit(tx, updated.budgetId, actor, 'commitment updated');
  }
  return updated;
}


export interface CreateScenarioInput {
  budgetId: string;
  organizationId: string;
  kind: 'BEST_CASE' | 'EXPECTED_CASE' | 'WORST_CASE' | 'CUSTOM';
  name: string;
  description?: string | null;
  adjustmentFactor: number | string;
  createdById?: string | null;
}

/**
 * Creates a scenario projection. Scenarios are non-destructive: they store an
 * adjustment factor and never touch the budget lines, so projecting a worst case
 * can never change the real budget.
 */
export async function createScenario(
  tx: Prisma.TransactionClient,
  input: CreateScenarioInput,
  actor: BudgetActor,
): Promise<{ id: string; kind: string }> {
  const budget = await getBudgetOrThrow(tx, input.budgetId, input.organizationId);
  const factor = dec(input.adjustmentFactor);
  if (factor.isNegative()) {
    throw new ValidationError('A scenario adjustment factor cannot be negative.');
  }

  const scenario = await tx.budgetScenario.create({
    data: {
      organizationId: input.organizationId,
      budgetId: budget.id,
      kind: input.kind,
      name: input.name,
      description: input.description ?? null,
      adjustmentFactor: factor,
      createdById: input.createdById ?? null,
    },
    select: { id: true, kind: true },
  });

  await writeAuditEntry(
    tx,
    { id: actor.id, name: actor.name, roleCodes: actor.roleCodes },
    {
      action: 'BUDGET_SCENARIO_CREATED',
      entityType: 'BUDGET_SCENARIO',
      entityId: scenario.id,
      entityLabel: `${budget.code} ${input.kind}`,
      description: `Created ${input.kind} scenario "${input.name}" for budget ${budget.code} (non-destructive)`,
      metadata: { budgetId: budget.id, kind: input.kind, adjustmentFactor: factor.toString() },
    },
    { organizationId: input.organizationId },
  );

  return scenario;
}

export interface VsActualLine {
  lineId: string;
  accountId: string;
  account: { code: string; name: string; type: string };
  approved: string;
  committed: string;
  actual: string;
  available: string;
  isOverBudget: boolean;
  percentSpent: number;
}

export interface VsActualView {
  budget: {
    id: string;
    code: string;
    name: string;
    status: string;
    type: string;
    periodType: string;
    startDate: Date;
    endDate: Date;
    currencyCode: string;
    approved: string;
    committed: string;
    actual: string;
    available: string;
    isOverBudget: boolean;
  };
  lines: VsActualLine[];
  warnings: string[];
}

export interface BudgetListFilters {
  status?: BudgetStatus;
  type?: BudgetLevel;
  projectId?: string;
  departmentId?: string;
  fundingSourceId?: string;
  dateFrom?: Date;
  dateTo?: Date;
}

export async function listBudgets(
  tx: Prisma.TransactionClient,
  organizationId: string,
  filters: BudgetListFilters = {},
) {
  const where: Prisma.BudgetWhereInput = { organizationId };
  if (filters.status) where.status = filters.status;
  if (filters.type) where.type = filters.type;
  if (filters.projectId) where.projectId = filters.projectId;
  if (filters.departmentId) where.departmentId = filters.departmentId;
  if (filters.fundingSourceId) where.fundingSourceId = filters.fundingSourceId;
  if (filters.dateFrom) where.endDate = { gte: filters.dateFrom };
  if (filters.dateTo) where.startDate = { lte: filters.dateTo };

  const budgets = await tx.budget.findMany({
    where,
    orderBy: [{ startDate: 'desc' }, { code: 'asc' }],
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      type: true,
      periodType: true,
      startDate: true,
      endDate: true,
      currencyCode: true,
      projectId: true,
      departmentId: true,
      fundingSourceId: true,
      _count: { select: { lines: true } },
    },
  });

  const data = [];
  for (const budget of budgets) {
    const availability = await recomputeAvailability(tx, budget.id);
    data.push({
      ...budget,
      lineCount: budget._count.lines,
      approved: availability.approved.toString(),
      committed: availability.committed.toString(),
      actual: availability.actual.toString(),
      available: availability.available.toString(),
      isOverBudget: availability.isOverBudget,
    });
  }
  return data;
}

export async function getBudgetVsActual(
  tx: Prisma.TransactionClient,
  budgetId: string,
  organizationId: string,
): Promise<VsActualView> {
  const budget = await tx.budget.findFirst({
    where: { id: budgetId, organizationId },
    include: {
      lines: {
        include: { account: { select: { id: true, code: true, name: true, type: true } } },
        orderBy: [{ account: { code: 'asc' } }],
      },
      fundingSource: { select: { code: true, isRestricted: true } },
    },
  });
  if (!budget) throw new NotFoundError('Budget', budgetId);

  const availability = await recomputeAvailability(tx, budget.id);
  const amountsByLine = new Map(availability.lines.map((line) => [line.lineId, line]));
  const warnings: string[] = [];
  if (availability.isOverBudget) warnings.push('Available budget is below zero.');
  if (budget.status !== 'ACTIVE') warnings.push('This budget is not active and does not govern new postings.');
  if (budget.fundingSource?.isRestricted) {
    warnings.push(`Restricted funding rules apply for ${budget.fundingSource.code}.`);
  }

  const lines: VsActualLine[] = budget.lines.map((line) => {
    const figures = amountsByLine.get(line.id);
    const approved = dec(line.amount);
    const committed = figures?.committed ?? ZERO();
    const actual = figures?.actual ?? ZERO();
    const available = figures?.available ?? approved.minus(committed).minus(actual);
    const isOverBudget = available.isNegative();
    if (isOverBudget) warnings.push(`${line.account.code} is over budget.`);
    return {
      lineId: line.id,
      accountId: line.accountId,
      account: line.account,
      approved: approved.toString(),
      committed: committed.toString(),
      actual: actual.toString(),
      available: available.toString(),
      isOverBudget,
      percentSpent: approved.isZero() ? 0 : actual.div(approved).times(100).toNumber(),
    };
  });

  return {
    budget: {
      id: budget.id,
      code: budget.code,
      name: budget.name,
      status: budget.status,
      type: budget.type,
      periodType: budget.periodType,
      startDate: budget.startDate,
      endDate: budget.endDate,
      currencyCode: budget.currencyCode,
      approved: availability.approved.toString(),
      committed: availability.committed.toString(),
      actual: availability.actual.toString(),
      available: availability.available.toString(),
      isOverBudget: availability.isOverBudget,
    },
    lines,
    warnings,
  };
}

export async function listBudgetRevisions(
  tx: Prisma.TransactionClient,
  budgetId: string,
  organizationId: string,
) {
  const budget = await getBudgetOrThrow(tx, budgetId, organizationId);
  const revisions = await tx.budgetRevision.findMany({
    where: { budgetId: budget.id, organizationId },
    orderBy: { revisionNumber: 'desc' },
    include: {
      lines: {
        include: { budgetLine: { include: { account: { select: { code: true, name: true } } } } },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  return revisions.map((revision) => ({
    id: revision.id,
    revisionNumber: revision.revisionNumber,
    reason: revision.reason,
    status: revision.status,
    createdAt: revision.createdAt,
    submittedAt: revision.submittedAt,
    approvedAt: revision.approvedAt,
    rejectedAt: revision.rejectedAt,
    lines: revision.lines.map((line) => ({
      id: line.id,
      budgetLineId: line.budgetLineId,
      accountId: line.accountId,
      account: line.budgetLine.account,
      beforeAmount: line.beforeAmount.toString(),
      afterAmount: line.afterAmount.toString(),
    })),
  }));
}

export async function listBudgetTransfers(
  tx: Prisma.TransactionClient,
  budgetId: string,
  organizationId: string,
) {
  const budget = await getBudgetOrThrow(tx, budgetId, organizationId);
  const transfers = await tx.budgetTransfer.findMany({
    where: { budgetId: budget.id, organizationId },
    orderBy: { transferNumber: 'desc' },
    include: {
      fromLine: { include: { account: { select: { id: true, code: true, name: true } } } },
      toLine: { include: { account: { select: { id: true, code: true, name: true } } } },
    },
  });
  return transfers.map((transfer) => ({
    id: transfer.id,
    transferNumber: transfer.transferNumber,
    amount: transfer.amount.toString(),
    reason: transfer.reason,
    status: transfer.status,
    createdAt: transfer.createdAt,
    approvedAt: transfer.approvedAt,
    appliedAt: transfer.appliedAt,
    fromLine: { id: transfer.fromLine.id, account: transfer.fromLine.account },
    toLine: { id: transfer.toLine.id, account: transfer.toLine.account },
  }));
}

export async function listBudgetScenarios(
  tx: Prisma.TransactionClient,
  budgetId: string,
  organizationId: string,
) {
  const view = await getBudgetVsActual(tx, budgetId, organizationId);
  const scenarios = await tx.budgetScenario.findMany({
    where: { budgetId, organizationId },
    orderBy: { createdAt: 'desc' },
  });
  return scenarios.map((scenario) => {
    const factor = dec(scenario.adjustmentFactor);
    const projectedActual = dec(view.budget.actual).times(factor);
    return {
      id: scenario.id,
      kind: scenario.kind,
      name: scenario.name,
      description: scenario.description,
      adjustmentFactor: factor.toString(),
      createdAt: scenario.createdAt,
      projectedActual: projectedActual.toString(),
      projectedAvailable: dec(view.budget.approved)
        .minus(dec(view.budget.committed))
        .minus(projectedActual)
        .toString(),
    };
  });
}

export async function listCommitments(
  tx: Prisma.TransactionClient,
  organizationId: string,
  filters: { budgetId?: string; status?: CommitmentStatus; accountId?: string } = {},
) {
  const where: Prisma.CommitmentWhereInput = { organizationId };
  if (filters.budgetId) where.budgetId = filters.budgetId;
  if (filters.status) where.status = filters.status;
  if (filters.accountId) where.accountId = filters.accountId;
  const commitments = await tx.commitment.findMany({
    where,
    orderBy: [{ expectedDate: 'asc' }, { commitmentDate: 'desc' }],
    include: {
      account: { select: { id: true, code: true, name: true } },
      budget: { select: { id: true, code: true, name: true } },
      budgetLine: { select: { id: true } },
    },
  });
  return commitments.map((commitment) => ({
    id: commitment.id,
    source: commitment.source,
    sourceId: commitment.sourceId,
    description: commitment.description,
    amount: commitment.amount.toString(),
    currencyCode: commitment.currencyCode,
    status: commitment.status,
    commitmentDate: commitment.commitmentDate,
    expectedDate: commitment.expectedDate,
    settledAt: commitment.settledAt,
    releasedAt: commitment.releasedAt,
    account: commitment.account,
    budget: commitment.budget,
    budgetLine: commitment.budgetLine,
    projectId: commitment.projectId,
    departmentId: commitment.departmentId,
    fundingSourceId: commitment.fundingSourceId,
  }));
}

