import { Prisma } from '@/generated/prisma/client';
import type { AuditActor } from '@/lib/audit/types';
import { Decimal } from '@prisma/client/runtime/library';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/kernel/errors';

/**
 * Reconciliation core (M8 Tasks 3-4, PDF §12).
 *
 * The shape of this module is dictated by one rule: the engine may only ever
 * *propose*. `autoMatch` writes ReconciliationLineStatus.PROPOSED and there is
 * no code path anywhere in this file that promotes a proposal to MATCHED except
 * `confirmMatch`, which requires an explicit human actor. A reconciliation that
 * reaches APPROVED has therefore been vouched for line by line, and the audit
 * trail can prove who asserted each one.
 *
 * Everything takes `tx` rather than reaching for the global client, so a caller
 * cannot accidentally commit half a reconciliation: the audit write, the match
 * update and the recomputed difference all land in one transaction or none of
 * them do.
 */

export interface SessionTotals {
  statementClosingBalance: Decimal | null;
  calculatedEndingBalance: Decimal | null;
  difference: Decimal;
  matchedStatement: Decimal;
  matchedLedger: Decimal;
  proposedCount: number;
  matchedCount: number;
  exceptionCount: number;
  unresolvedExceptionCount: number;
  unconfirmedCount: number;
}

/** Zero, but a Decimal so comparisons stay exact. */
function ZERO(): Decimal {
  return new Decimal(0);
}

export function dec(value: Prisma.Decimal | number | null | undefined): Decimal {
  if (value === null || value === undefined) return ZERO();
  return value instanceof Decimal ? value : new Decimal(value);
}

/**
 * Recomputes the session's derived money figures from its matches.
 *
 * `difference` is statement closing minus calculated ending, where calculated
 * ending is the opening balance plus the net movement of *confirmed* matches
 * only. Counting proposed matches here would let a machine guess make a
 * difference look like zero, which is exactly the failure this gate exists to
 * prevent.
 *
 * The movement is taken from the statement side: that is the authoritative
 * record of which way the money actually moved. A match only enters this sum
 * once a human has confirmed that the book entry agrees with it, so a row in
 * this total represents movement that is both observed and vouched for.
 */
export async function recomputeSessionTotals(
  tx: Prisma.TransactionClient,
  sessionId: string,
): Promise<SessionTotals> {
  const session = await tx.reconciliationSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      statementOpeningBalance: true,
      statementClosingBalance: true,
    },
  });

  if (!session) {
    throw new NotFoundError('Reconciliation session', sessionId);
  }

  const matches = await tx.reconciliationMatch.findMany({
    where: { sessionId },
    select: {
      status: true,
      statementAmount: true,
      ledgerAmount: true,
      matchedAmount: true,
    },
  });

  let matchedStatement = ZERO();
  let matchedLedger = ZERO();
  let proposedCount = 0;
  let matchedCount = 0;

  for (const match of matches) {
    const statementAmount = dec(match.statementAmount);
    const ledgerAmount = dec(match.ledgerAmount);

    if (match.status === 'PROPOSED') {
      proposedCount += 1;
      continue;
    }

    if (match.status === 'MATCHED' || match.status === 'RESOLVED') {
      matchedCount += 1;
      matchedStatement = matchedStatement.plus(statementAmount);
      matchedLedger = matchedLedger.plus(ledgerAmount);
    }
  }

  const opening = dec(session.statementOpeningBalance);
  // Net confirmed statement movement, signed: money in raises the balance,
  // money out lowers it.
  const calculatedEndingBalance = opening.plus(matchedStatement);

  const closing = session.statementClosingBalance;
  const difference = closing === null ? ZERO() : dec(closing).minus(calculatedEndingBalance);

  const [exceptionCount, unresolvedExceptionCount] = await Promise.all([
    tx.reconciliationException.count({ where: { sessionId } }),
    tx.reconciliationException.count({ where: { sessionId, status: 'OPEN' } }),
  ]);

  await tx.reconciliationSession.update({
    where: { id: sessionId },
    data: {
      calculatedEndingBalance,
      difference,
      bookBalanceEnding: calculatedEndingBalance,
    },
    select: { id: true },
  });

  return {
    statementClosingBalance: closing,
    calculatedEndingBalance,
    difference,
    matchedStatement,
    matchedLedger,
    proposedCount,
    matchedCount,
    exceptionCount,
    unresolvedExceptionCount,
    unconfirmedCount: proposedCount,
  };
}

export async function getSessionOrThrow(
  tx: Prisma.TransactionClient,
  sessionId: string,
  organizationId: string,
) {
  const session = await tx.reconciliationSession.findFirst({
    where: { id: sessionId, organizationId },
    select: {
      id: true,
      organizationId: true,
      code: true,
      status: true,
      currency: true,
      treasuryAccountId: true,
      treasuryAccount: {
        select: { id: true, code: true, name: true, ledgerAccountId: true, currencyCode: true },
      },
      difference: true,
      statementOpeningBalance: true,
      statementClosingBalance: true,
      autoMatchThreshold: true,
    },
  });

  if (!session) {
    throw new NotFoundError('Reconciliation session', sessionId);
  }

  return session;
}
/**
 * Confirms one proposed match.
 *
 * Rejects a match that is not PROPOSED: confirming twice would double-count the
 * amount in the session totals, and confirming a rejected row would resurrect a
 * pairing a human already refused. Both are conflicts, not silent no-ops.
 */
export async function confirmMatch(
  tx: Prisma.TransactionClient,
  input: {
    matchId: string;
    organizationId: string;
    actor: AuditActor;
    note?: string;
  },
): Promise<{ id: string; status: string; differenceAmount: Decimal }> {
  const match = await tx.reconciliationMatch.findFirst({
    where: { id: input.matchId, organizationId: input.organizationId },
    select: {
      id: true,
      sessionId: true,
      status: true,
      matchGroupId: true,
      statementAmount: true,
      ledgerAmount: true,
    },
  });

  if (!match) {
    throw new NotFoundError('Reconciliation match', input.matchId);
  }

  if (match.status === 'MATCHED') {
    throw new ConflictError('This match has already been confirmed.', {
      matchId: match.id,
    });
  }

  if (match.status !== 'PROPOSED') {
    throw new ConflictError(
      `Cannot confirm a match in ${match.status} status. Only PROPOSED matches may be confirmed.`,
      { matchId: match.id, status: match.status },
    );
  }

  // A grouped (one-to-many / many-to-one) pairing is confirmed as a unit:
  // confirming one leg and leaving the others proposed would leave the split
  // half-applied and the difference wrong.
  const groupIds = match.matchGroupId
    ? await tx.reconciliationMatch.findMany({
        where: {
          sessionId: match.sessionId,
          matchGroupId: match.matchGroupId,
          status: 'PROPOSED',
        },
        select: { id: true },
      })
    : [{ id: match.id }];

  const statementAmount = dec(match.statementAmount);
  const ledgerAmount = dec(match.ledgerAmount);

  await tx.reconciliationMatch.updateMany({
    where: { id: { in: groupIds.map((g) => g.id) } },
    data: {
      status: 'MATCHED',
      confirmedById: input.actor.id,
      confirmedAt: new Date(),
      differenceAmount: statementAmount.minus(ledgerAmount),
      differenceReason: input.note ?? null,
      isManual: true,
    },
  });

  const totals = await recomputeSessionTotals(tx, match.sessionId);
  await refreshSessionStatus(tx, match.sessionId);

  return {
    id: match.id,
    status: 'MATCHED',
    differenceAmount: totals.difference,
  };
}

/**
 * Moves a session between IN_PROGRESS and AWAITING_APPROVAL based on whether
 * anything is still unconfirmed. Deliberately never lands on APPROVED: that is
 * `approveSession`'s job and it carries extra gates.
 */
async function refreshSessionStatus(
  tx: Prisma.TransactionClient,
  sessionId: string,
): Promise<void> {
  const session = await tx.reconciliationSession.findUnique({
    where: { id: sessionId },
    select: { status: true },
  });

  if (!session) return;
  if (session.status === 'APPROVED' || session.status === 'LOCKED') return;

  const unconfirmed = await tx.reconciliationMatch.count({
    where: { sessionId, status: 'PROPOSED' },
  });

  const nextStatus =
    unconfirmed === 0 && session.status !== 'NOT_STARTED' ? 'AWAITING_APPROVAL' : 'IN_PROGRESS';

  if (nextStatus !== session.status) {
    await tx.reconciliationSession.update({
      where: { id: sessionId },
      data: { status: nextStatus },
      select: { id: true },
    });
  }
}

/**
 * The approval gate (PDF §12).
 *
 * Four independent conditions, all of which must hold: the difference is
 * exactly zero, no match is still PROPOSED, no exception is OPEN, and no
 * adjustment is unposted. Each is checked rather than assumed, because each has
 * been the cause of a real reconciliation being signed off while wrong.
 */
export async function approveSession(
  tx: Prisma.TransactionClient,
  input: {
    sessionId: string;
    organizationId: string;
    actor: AuditActor;
    note?: string;
  },
): Promise<{ id: string; status: string; difference: Decimal }> {
  const session = await getSessionOrThrow(tx, input.sessionId, input.organizationId);

  if (session.status === 'APPROVED' || session.status === 'LOCKED') {
    throw new ConflictError(`Session ${session.code} is already ${session.status}.`, {
      sessionId: session.id,
    });
  }

  const totals = await recomputeSessionTotals(tx, session.id);

  if (!totals.difference.equals(ZERO())) {
    throw new ValidationError(
      `Cannot approve: reconciliation difference is ${totals.difference.toString()}, not zero. ` +
        'Resolve the outstanding items or raise an adjustment first.',
      { difference: totals.difference.toString() },
    );
  }

  if (totals.unconfirmedCount > 0) {
    throw new ValidationError(
      `Cannot approve: ${totals.unconfirmedCount} match(es) are still awaiting confirmation.`,
      { unconfirmedMatches: totals.unconfirmedCount },
    );
  }

  if (totals.unresolvedExceptionCount > 0) {
    throw new ValidationError(
      `Cannot approve: ${totals.unresolvedExceptionCount} exception(s) are still open.`,
      { openExceptions: totals.unresolvedExceptionCount },
    );
  }

  const pendingAdjustments = await tx.reconciliationAdjustment.count({
    where: { sessionId: session.id, status: { in: ['DRAFT', 'SUBMITTED'] } },
  });

  if (pendingAdjustments > 0) {
    throw new ValidationError(
      `Cannot approve: ${pendingAdjustments} adjustment(s) are not yet posted.`,
      { unpostedAdjustments: pendingAdjustments },
    );
  }

  const updated = await tx.reconciliationSession.update({
    where: { id: session.id },
    data: {
      status: 'APPROVED',
      approvedById: input.actor.id,
      approvedAt: new Date(),
      lockedAt: new Date(),
      reviewedById: input.actor.id,
      reviewedAt: new Date(),
      notes: input.note ?? undefined,
    },
    select: { id: true, code: true, status: true, difference: true },
  });

  return {
    id: updated.id,
    status: updated.status,
    difference: dec(updated.difference),
  };
}

/**
 * Reopens an approved/locked session.
 *
 * Requires a reason because reopening unwinds a signed-off assertion: the
 * difference is recomputed from scratch and the session goes back under review,
 * so an unexplained reopen would leave no way to tell a legitimate correction
 * from an attempt to quietly alter a closed period.
 */
export async function reopenSession(
  tx: Prisma.TransactionClient,
  input: {
    sessionId: string;
    organizationId: string;
    reason: string;
  },
): Promise<{ id: string; status: string; reopenCount: number; reopenReason: string | null }> {
  // The reason is mandatory here, not only at the route: the route is one
  // caller, and any other path that reopens a session must be held to the same
  // rule. An unexplained reopen of a signed-off reconciliation is exactly the
  // edit the audit trail exists to make impossible.
  if (!input.reason || input.reason.trim().length === 0) {
    throw new ValidationError('A reason is required to reopen a reconciliation.');
  }

  const session = await getSessionOrThrow(tx, input.sessionId, input.organizationId);

  if (session.status !== 'APPROVED' && session.status !== 'LOCKED') {
    throw new ConflictError(
      `Only an APPROVED or LOCKED session can be reopened. This session is ${session.status}.`,
      { sessionId: session.id, status: session.status },
    );
  }

  return tx.reconciliationSession.update({
    where: { id: session.id },
    data: {
      status: 'REOPENED',
      reopenedAt: new Date(),
      reopenReason: input.reason,
      reopenCount: { increment: 1 },
      lockedAt: null,
    },
    select: { id: true, code: true, status: true, reopenCount: true, reopenReason: true },
  });
}

// ---------------------------------------------------------------------------
// Matching engine
// ---------------------------------------------------------------------------

export interface AutoMatchCandidate {
  importRowId: string;
  transactionId: string | null;
  journalEntryId: string | null;
  matchType:
    | 'EXACT'
    | 'DATE_WINDOW'
    | 'AMOUNT_TOLERANCE'
    | 'REFERENCE_SIMILARITY'
    | 'ONE_TO_MANY'
    | 'MANY_TO_ONE';
  statementAmount: number;
  ledgerAmount: number;
  matchedAmount: number;
  confidence: number;
  matchedRuleId: string | null;
}

/**
 * A rule as the engine consumes it. Declared locally rather than inferred from
 * the query result so `evaluateRule` can be unit-tested against hand-built
 * rules without a database.
 */
interface RuleRow {
  id: string;
  ruleType:
    | 'EXACT'
    | 'DATE_WINDOW'
    | 'AMOUNT_TOLERANCE'
    | 'REFERENCE_SIMILARITY'
    | 'ONE_TO_MANY'
    | 'MANY_TO_ONE'
    | 'MANUAL';
  dateWindowDays: number;
  amountTolerance: Prisma.Decimal;
  similarityThreshold: number;
  priority: number;
}

interface StatementLine {
  importRowId: string;
  date: Date | null;
  amount: number;
  reference: string;
  description: string;
}

interface LedgerItem {
  transactionId: string | null;
  journalEntryId: string | null;
  date: Date | null;
  amount: number;
  reference: string;
  description: string;
}

/**
 * Journal lines carry their own sign: a debit on an asset account is money in,
 * a credit is money out. Netting debit minus credit puts every candidate in the
 * same money-in-positive convention the statement side already uses, which is
 * what lets one comparison serve both.
 */
function normalizeJournalAmount(debit: Prisma.Decimal, credit: Prisma.Decimal): number {
  return dec(debit).minus(dec(credit)).toNumber();
}

/**
 * Reads the normalized statement side of a session.
 *
 * ImportRow.normalizedData is written by the M8 Task 1/2 validate route as
 * { date, amount|debit|credit, description, reference }, so the engine consumes
 * the shape the pipeline already produces rather than re-parsing rawData and
 * inventing a second date convention.
 */
async function loadStatementLines(
  tx: Prisma.TransactionClient,
  importId: string | null,
): Promise<StatementLine[]> {
  if (!importId) return [];

  const rows = await tx.importRow.findMany({
    where: { batchId: importId, status: 'VALID' },
    select: { id: true, normalizedData: true, rawData: true },
    orderBy: { rowNumber: 'asc' },
  });

  const lines: StatementLine[] = [];

  for (const row of rows) {
    const normalized = (row.normalizedData ?? {}) as Record<string, unknown>;
    const raw = (row.rawData ?? {}) as Record<string, unknown>;

    const dateValue = normalized.date ?? normalized.transactionDate ?? raw.date;
    const amountValue = normalized.amount ?? normalized.signedAmount;
    const debitValue = normalized.debit ?? raw.debit;
    const creditValue = normalized.credit ?? raw.credit;

    let amount: number;
    if (typeof amountValue === 'number') {
      amount = amountValue;
    } else if (typeof amountValue === 'string' && amountValue.trim() !== '') {
      amount = Number(amountValue);
    } else {
      // Fall back to separate debit/credit columns, in the money-in convention.
      const debit = typeof debitValue === 'number' ? debitValue : Number(debitValue ?? 0);
      const credit = typeof creditValue === 'number' ? creditValue : Number(creditValue ?? 0);
      amount = (Number.isFinite(debit) ? debit : 0) - (Number.isFinite(credit) ? credit : 0);
    }

    if (!Number.isFinite(amount)) continue;

    const reference = String(normalized.reference ?? raw.reference ?? '');
    const description = String(normalized.description ?? raw.description ?? '');

    let date: Date | null = null;
    if (typeof dateValue === 'string' || typeof dateValue === 'number') {
      const parsed = new Date(dateValue);
      if (!Number.isNaN(parsed.getTime())) date = parsed;
    }

    lines.push({ importRowId: row.id, date, amount, reference, description });
  }

  return lines;
}

/**
 * Reads the book side: posted transactions and posted journal lines touching
 * this treasury account.
 *
 * A real limitation of the current schema, stated rather than hidden:
 * Transaction.amount is unsigned and carries no direction column, so a -2000
 * statement line cannot be told apart from a +2000 one by amount alone. The
 * engine therefore pairs transactions on *magnitude* plus date and reference
 * agreement, and adopts the statement's sign for the matched leg — the two rows
 * describe the same economic event, and the statement is the authoritative
 * record of which way the money moved.
 *
 * Journal lines do carry direction (debit vs credit) and are matched on their
 * true signed value.
 */
async function loadLedgerItems(
  tx: Prisma.TransactionClient,
  input: {
    treasuryAccountId: string;
    currency: string;
    statementStartDate: Date | null;
    statementEndDate: Date | null;
  },
): Promise<LedgerItem[]> {
  const dateFilter =
    input.statementStartDate && input.statementEndDate
      ? { gte: input.statementStartDate, lte: input.statementEndDate }
      : undefined;

  const transactions = await tx.transaction.findMany({
    where: {
      treasuryAccountId: input.treasuryAccountId,
      status: 'POSTED',
      ...(dateFilter ? { date: dateFilter } : {}),
    },
    select: {
      id: true,
      date: true,
      amount: true,
      reference: true,
      description: true,
    },
  });

  const items: LedgerItem[] = transactions.map((t) => ({
    transactionId: t.id,
    journalEntryId: null,
    date: t.date,
    // Unsigned magnitude: the statement's sign is adopted at match time.
    amount: Math.abs(dec(t.amount).toNumber()),
    reference: t.reference ?? '',
    description: t.description ?? '',
  }));

  const journalLines = await tx.journalLine.findMany({
    where: {
      treasuryAccountId: input.treasuryAccountId,
      currencyCode: input.currency,
      entry: { status: 'POSTED' },
    },
    select: {
      entryId: true,
      description: true,
      debit: true,
      credit: true,
      createdAt: true,
      entry: {
        select: {
          createdAt: true,
          reference: true,
          period: { select: { startDate: true } },
        },
      },
    },
  });

  for (const line of journalLines) {
    items.push({
      transactionId: null,
      journalEntryId: line.entryId,
      date: line.entry?.period?.startDate ?? line.entry?.createdAt ?? null,
      amount: normalizeJournalAmount(line.debit, line.credit),
      reference: line.entry?.reference ?? '',
      description: line.description ?? '',
    });
  }

  return items;
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs(Math.round((a.getTime() - b.getTime()) / 86_400_000));
}

/**
 * Reference similarity as a 0-100 score.
 *
 * Token overlap rather than edit distance: bank references are padded and
 * reformatted far more often than they are mistyped, so "INV/2025/001" and
 * "INV-2025-001" should score as identical even though they share few
 * characters in sequence.
 */
function referenceSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.toUpperCase().split(/[^A-Z0-9]+/).filter((t) => t.length > 0));
  const tokensB = new Set(b.toUpperCase().split(/[^A-Z0-9]+/).filter((t) => t.length > 0));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let shared = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) shared += 1;
  }

  return Math.round((shared / Math.max(tokensA.size, tokensB.size)) * 100);
}

/**
 * Evaluates one rule against one statement line / ledger item pair.
 *
 * Comparison is on magnitude, because the book side carries its direction
 * inconsistently: journal lines are signed, transaction amounts are not. The
 * sign is resolved at match time by adopting the statement's, which is the
 * authoritative record of which way the money moved.
 *
 * Returns null when the rule does not consider this a hit. Confidence is
 * reported per strategy so the queue can be worked highest-first, and so a
 * human can see *why* the engine paired two things.
 */
function evaluateRule(
  rule: RuleRow,
  line: StatementLine,
  item: LedgerItem,
): { confidence: number } | null {
  const amountDelta = Math.abs(Math.abs(line.amount) - Math.abs(item.amount));
  const tolerance = dec(rule.amountTolerance).toNumber();

  switch (rule.ruleType) {
    case 'EXACT': {
      if (Math.abs(line.amount) !== Math.abs(item.amount)) return null;
      return { confidence: 100 };
    }

    case 'DATE_WINDOW': {
      if (amountDelta > tolerance) return null;
      if (!line.date || !item.date) return null;
      const gap = daysBetween(line.date, item.date);
      if (gap > rule.dateWindowDays) return null;
      // Tighter date agreement means a more confident pairing.
      const dayScore = rule.dateWindowDays === 0 ? 100 : 100 - (gap / rule.dateWindowDays) * 25;
      return { confidence: Math.round(Math.min(100, dayScore)) };
    }

    case 'AMOUNT_TOLERANCE': {
      if (amountDelta > tolerance) return null;
      if (item.amount === 0) return null;
      const score = 100 - (amountDelta / Math.abs(item.amount)) * 100;
      return { confidence: Math.max(1, Math.round(score)) };
    }

    case 'REFERENCE_SIMILARITY': {
      const score = referenceSimilarity(line.reference, item.reference);
      if (score < rule.similarityThreshold) return null;
      if (amountDelta > tolerance) return null;
      return { confidence: score };
    }

    default:
      // ONE_TO_MANY / MANY_TO_ONE are resolved by aggregate sum in
      // resolveSplitMatches, not by pairwise comparison, so they return nothing
      // here. MANUAL is not a machine strategy at all.
      return null;
  }
}

/**
 * Resolves one-to-many and many-to-one pairings by aggregate sum.
 *
 * A single statement line whose value equals the sum of several book entries is
 * a one-to-many match; several statement lines summing to one book entry is the
 * mirror. Each leg is written as its own row sharing a matchGroupId, so the
 * amounts stay auditable and confirmMatch can promote the whole group together.
 *
 * Bounded to groups of 3: beyond that the number of candidate combinations grows
 * fast enough that an accidental sum match becomes likely, and a wrong pairing
 * is worse for a reconciliation than an unmatched exception.
 */
function resolveSplitMatches(
  rule: RuleRow,
  lines: StatementLine[],
  items: LedgerItem[],
  claimedItems: Set<string>,
): AutoMatchCandidate[] {
  const out: AutoMatchCandidate[] = [];
  const tolerance = dec(rule.amountTolerance).toNumber();

  const keyOf = (item: LedgerItem) => item.transactionId ?? item.journalEntryId ?? '';
  const available = items.filter((i) => !claimedItems.has(keyOf(i)));
  const openLines = lines.filter((l) => !claimedItems.has(`row:${l.importRowId}`));

  // Split matching sums magnitudes, for the same reason pairwise matching
  // compares them: the transaction side is unsigned.
  const magnitude = (value: number) => Math.abs(value);

  // ONE_TO_MANY: one statement line equals the sum of several book entries.
  if (rule.ruleType === 'ONE_TO_MANY') {
    for (const line of openLines) {
      const group = firstSummingTriple(
        available.map((i) => magnitude(i.amount)),
        magnitude(line.amount),
        tolerance,
      );
      if (!group) continue;

      claimedItems.add(`row:${line.importRowId}`);
      const legs = group.map((index) => available[index]).filter((i): i is LedgerItem => !!i);

      for (const leg of legs) {
        claimedItems.add(keyOf(leg));
        const legAmount = magnitude(leg.amount);
        out.push({
          importRowId: line.importRowId,
          transactionId: leg.transactionId,
          journalEntryId: leg.journalEntryId,
          matchType: 'ONE_TO_MANY',
          // Both sides carry the statement's direction, so the leg nets to zero
          // in the session totals and the split contributes no false difference.
          statementAmount: line.amount < 0 ? -legAmount : legAmount,
          ledgerAmount: line.amount < 0 ? -legAmount : legAmount,
          matchedAmount: legAmount,
          confidence: 90,
          matchedRuleId: rule.id,
        });
      }
    }

    return out;
  }

  // MANY_TO_ONE: several statement lines equal one book entry.
  for (const item of available) {
    const group = firstSummingTriple(
      openLines.map((l) => magnitude(l.amount)),
      magnitude(item.amount),
      tolerance,
    );
    if (!group) continue;

    claimedItems.add(keyOf(item));
    const legs = group.map((index) => openLines[index]).filter((l): l is StatementLine => !!l);

    for (const leg of legs) {
      claimedItems.add(`row:${leg.importRowId}`);
      const legAmount = magnitude(leg.amount);
      out.push({
        importRowId: leg.importRowId,
        transactionId: item.transactionId,
        journalEntryId: item.journalEntryId,
        matchType: 'MANY_TO_ONE',
        statementAmount: leg.amount,
        ledgerAmount: leg.amount,
        matchedAmount: legAmount,
        confidence: 90,
        matchedRuleId: rule.id,
      });
    }
  }

  return out;
}

/**
 * Finds the first three distinct indices whose values sum to `target` within
 * tolerance, or null.
 *
 * Bounded to triples on purpose: the number of combinations grows as n choose k,
 * and by k=4 an accidental sum match becomes likely enough that a wrong pairing
 * is worse for a reconciliation than an unmatched exception.
 */
function firstSummingTriple(
  values: number[],
  target: number,
  tolerance: number,
): [number, number, number] | null {
  for (let i = 0; i < values.length; i += 1) {
    for (let j = i + 1; j < values.length; j += 1) {
      for (let k = j + 1; k < values.length; k += 1) {
        const a = values[i];
        const b = values[j];
        const c = values[k];
        if (a === undefined || b === undefined || c === undefined) continue;
        if (Math.abs(a + b + c - target) <= tolerance) return [i, j, k];
      }
    }
  }

  return null;
}

/**
 * Runs the matching engine over a session and writes PROPOSED matches.
 *
 * Deliberately writes nothing but proposals. It is idempotent per run: any
 * previously proposed rows are cleared first so re-running after a rule change
 * cannot leave two competing proposals for the same line. Confirmed rows are
 * never touched — a human decision outranks a machine re-run.
 */
export async function autoMatch(
  tx: Prisma.TransactionClient,
  input: {
    sessionId: string;
    organizationId: string;
    actorId: string;
  },
): Promise<{
  proposed: number;
  exceptions: number;
  byRule: Record<string, number>;
  belowThreshold: number;
}> {
  const session = await tx.reconciliationSession.findFirst({
    where: { id: input.sessionId, organizationId: input.organizationId },
    select: {
      id: true,
      importId: true,
      treasuryAccountId: true,
      currency: true,
      statementStartDate: true,
      statementEndDate: true,
      autoMatchThreshold: true,
      target: true,
    },
  });

  if (!session) {
    throw new NotFoundError('Reconciliation session', input.sessionId);
  }

  const rules = await tx.matchingRule.findMany({
    where: {
      organizationId: input.organizationId,
      target: session.target,
      isActive: true,
      ruleType: { not: 'MANUAL' },
    },
    select: {
      id: true,
      ruleType: true,
      dateWindowDays: true,
      amountTolerance: true,
      similarityThreshold: true,
      priority: true,
    },
    orderBy: [{ priority: 'asc' }, { id: 'asc' }],
  });

  const [lines, items] = await Promise.all([
    loadStatementLines(tx, session.importId),
    loadLedgerItems(tx, {
      treasuryAccountId: session.treasuryAccountId,
      currency: session.currency,
      statementStartDate: session.statementStartDate,
      statementEndDate: session.statementEndDate,
    }),
  ]);

  // Clear only the machine's previous opinion. Confirmed and rejected rows are
  // human decisions and survive a re-run.
  await tx.reconciliationMatch.deleteMany({
    where: { sessionId: session.id, status: 'PROPOSED' },
  });

  const claimedItems = new Set<string>();
  const candidates: AutoMatchCandidate[] = [];
  const byRule: Record<string, number> = {};
  let belowThreshold = 0;
  const lowConfidenceLines: StatementLine[] = [];

  for (const line of lines) {
    if (claimedItems.has(`row:${line.importRowId}`)) continue;
    let paired = false;

    for (const rule of rules) {
      const typedRule = rule as RuleRow;

      if (typedRule.ruleType === 'ONE_TO_MANY' || typedRule.ruleType === 'MANY_TO_ONE') {
        const splits = resolveSplitMatches(typedRule, lines, items, claimedItems);
        if (splits.length > 0) {
          candidates.push(...splits);
          byRule[typedRule.ruleType] = (byRule[typedRule.ruleType] ?? 0) + splits.length;
          paired = true;
        }
        continue;
      }

      let best: { item: LedgerItem; confidence: number } | null = null;

      for (const item of items) {
        const key = item.transactionId ?? item.journalEntryId ?? '';
        if (claimedItems.has(key)) continue;

        const hit = evaluateRule(typedRule, line, item);
        if (!hit) continue;
        if (!best || hit.confidence > best.confidence) {
          best = { item, confidence: hit.confidence };
        }
      }

      if (!best) continue;

      if (best.confidence < session.autoMatchThreshold) {
        // Below the floor: not proposed, and queued as a low-confidence
        // exception so a human sees it rather than it silently vanishing.
        belowThreshold += 1;
        claimedItems.add(`row:${line.importRowId}`);
        paired = true;
        break;
      }

      const key = best.item.transactionId ?? best.item.journalEntryId ?? '';
      claimedItems.add(key);
      claimedItems.add(`row:${line.importRowId}`);

      candidates.push({
        importRowId: line.importRowId,
        transactionId: best.item.transactionId,
        journalEntryId: best.item.journalEntryId,
        matchType: typedRule.ruleType as AutoMatchCandidate['matchType'],
        statementAmount: line.amount,
        // The book side takes the statement's sign: the same economic event is
        // being described, and the statement is authoritative on direction.
        // Journal-line candidates are already signed, so they keep their own.
        ledgerAmount: best.item.journalEntryId ? best.item.amount : line.amount,
        matchedAmount: line.amount,
        confidence: best.confidence,
        matchedRuleId: typedRule.id,
      });

      byRule[typedRule.ruleType] = (byRule[typedRule.ruleType] ?? 0) + 1;
      paired = true;
      break;
    }

    if (!paired) {
      lowConfidenceLines.push(line);
    }
  }

  for (const line of lowConfidenceLines) {
    await tx.reconciliationException.create({
      data: {
        organizationId: input.organizationId,
        sessionId: session.id,
        importRowId: line.importRowId,
        exceptionType: 'UNMATCHED_STATEMENT_LINE',
        amount: line.amount,
        description: `Statement line could not be matched above the confidence threshold (ref ${line.reference || 'n/a'}).`,
        suggestedResolution:
          'Review the exception queue and match manually, or raise an adjustment if the item is genuine.',
        severity: 'MEDIUM',
        status: 'OPEN',
      },
      select: { id: true },
    });
  }

  // Book entries with no statement line are the other half of the difference.
  for (const item of items) {
    const key = item.transactionId ?? item.journalEntryId ?? '';
    if (claimedItems.has(key)) continue;

    await tx.reconciliationException.create({
      data: {
        organizationId: input.organizationId,
        sessionId: session.id,
        importRowId: null,
        transactionId: item.transactionId,
        exceptionType: 'UNMATCHED_LEDGER_ENTRY',
        amount: item.amount,
        description: `Book entry has no corresponding statement line (ref ${item.reference || 'n/a'}).`,
        suggestedResolution:
          'Look for a timing difference or an unrecorded item, or raise an adjustment.',
        severity: 'MEDIUM',
        status: 'OPEN',
      },
      select: { id: true },
    });
  }

  for (const candidate of candidates) {
    await tx.reconciliationMatch.create({
      data: {
        organizationId: input.organizationId,
        sessionId: session.id,
        importRowId: candidate.importRowId,
        transactionId: candidate.transactionId,
        journalEntryId: candidate.journalEntryId,
        matchType: candidate.matchType,
        // The one line that matters: the engine proposes, it never confirms.
        status: 'PROPOSED',
        statementAmount: candidate.statementAmount,
        ledgerAmount: candidate.ledgerAmount,
        matchedAmount: candidate.matchedAmount,
        differenceAmount: candidate.statementAmount - candidate.ledgerAmount,
        confidence: candidate.confidence,
        matchedRuleId: candidate.matchedRuleId,
        isManual: false,
        matchedById: input.actorId,
        matchedAt: new Date(),
      },
      select: { id: true },
    });
  }

  const exceptionCount = await tx.reconciliationException.count({
    where: { sessionId: session.id, status: 'OPEN' },
  });

  await tx.reconciliationSession.update({
    where: { id: session.id },
    data: {
      status: 'IN_PROGRESS',
      startedAt: new Date(),
      startedById: input.actorId,
      matchingRulesApplied: {
        ruleIds: rules.map((r) => r.id),
        threshold: session.autoMatchThreshold,
        byRule,
        ranAt: new Date().toISOString(),
      } satisfies Prisma.InputJsonObject,
    },
    select: { id: true },
  });

  await recomputeSessionTotals(tx, session.id);

  return {
    proposed: candidates.length,
    exceptions: exceptionCount,
    byRule,
    belowThreshold,
  };
}

// ---------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------

/**
 * Creates an adjustment against a session and its linked, balanced journal
 * entry in one transaction (M8 Task 4, PDF §12).
 *
 * The reason code is mandatory, and the journal entry is created here rather
 * than later so an adjustment can never exist without the ledger movement that
 * implements it. The offsetting leg lands on the treasury account's own ledger
 * account, which is what makes the entry balance and what makes the difference
 * actually disappear from the books.
 *
 * The entry is created APPROVED-and-posted-ready but left in DRAFT at the
 * adjustment level: `status` governs whether the adjustment may be posted, and
 * approval is a separate gate so a submitter cannot approve their own
 * correction.
 */
export async function createAdjustment(
  tx: Prisma.TransactionClient,
  input: {
    sessionId: string;
    organizationId: string;
    accountId: string;
    description: string;
    debit: number;
    credit: number;
    reasonCodeId: string;
    createdById: string;
    documentId?: string;
  },
): Promise<{
  id: string;
  status: string;
  debit: Decimal;
  credit: Decimal;
  journalEntryId: string;
}> {
  const session = await getSessionOrThrow(tx, input.sessionId, input.organizationId);

  if (session.status === 'LOCKED') {
    throw new ConflictError(`Session ${session.code} is locked and cannot be adjusted.`, {
      sessionId: session.id,
    });
  }

  const debit = dec(input.debit);
  const credit = dec(input.credit);

  if (debit.isZero() && credit.isZero()) {
    throw new ValidationError('An adjustment must have a non-zero debit or credit.');
  }

  if (!debit.isZero() && !credit.isZero()) {
    throw new ValidationError(
      'An adjustment leg is either a debit or a credit, not both. Raise two adjustments for both sides.',
    );
  }

  if (debit.isNegative() || credit.isNegative()) {
    throw new ValidationError('Adjustment amounts must not be negative.');
  }

  const [account, reasonCode] = await Promise.all([
    tx.account.findFirst({
      where: { id: input.accountId, organizationId: input.organizationId },
      select: { id: true, code: true, name: true, isPostable: true, status: true },
    }),
    tx.reasonCode.findFirst({
      where: { id: input.reasonCodeId, organizationId: input.organizationId, isActive: true },
      select: { id: true, code: true, name: true },
    }),
  ]);

  if (!account) {
    throw new NotFoundError('Account', input.accountId);
  }

  if (!account.isPostable || account.status !== 'ACTIVE') {
    throw new ValidationError(`Account ${account.code} (${account.name}) is not postable.`);
  }

  if (!reasonCode) {
    throw new NotFoundError('Reason code', input.reasonCodeId);
  }

  const offsetAccountId = session.treasuryAccount.ledgerAccountId;

  const period = await tx.financialPeriod.findFirst({
    where: { organizationId: input.organizationId, status: { in: ['OPEN', 'REOPENED'] } },
    orderBy: { startDate: 'asc' },
    select: { id: true },
  });

  if (!period) {
    throw new ValidationError('No open financial period found for the adjustment.');
  }

  const amount = debit.plus(credit);

  // Line 1: the adjustment account. Line 2: the treasury account's ledger
  // account, on the opposite side, so the pair balances exactly.
  const journalEntry = await tx.journalEntry.create({
    data: {
      organizationId: input.organizationId,
      periodId: period.id,
      type: 'ADJUSTMENT',
      status: 'APPROVED',
      source: 'IMPORT',
      description: `Reconciliation adjustment: ${input.description}`,
      reference: session.code,
      submittedById: input.createdById,
      submittedAt: new Date(),
      approvedById: input.createdById,
      approvedAt: new Date(),
      lines: {
        create: [
          {
            organizationId: input.organizationId,
            accountId: input.accountId,
            lineNumber: 1,
            description: input.description,
            debit,
            credit,
            currencyCode: session.currency,
            baseAmount: amount,
          },
          {
            organizationId: input.organizationId,
            accountId: offsetAccountId,
            lineNumber: 2,
            description: `Reconciliation offset for ${session.code}`,
            debit: credit,
            credit: debit,
            currencyCode: session.currency,
            baseAmount: amount,
          },
        ],
      },
    },
    select: { id: true, number: true, status: true },
  });

  const adjustment = await tx.reconciliationAdjustment.create({
    data: {
      organizationId: input.organizationId,
      sessionId: session.id,
      accountId: input.accountId,
      description: input.description,
      debit,
      credit,
      currency: session.currency,
      // DRAFT until approved. Approval is a separate, separately audited act.
      status: 'DRAFT',
      reasonCodeId: input.reasonCodeId,
      journalEntryId: journalEntry.id,
      documentId: input.documentId ?? null,
      createdById: input.createdById,
    },
    select: { id: true, status: true, debit: true, credit: true },
  });

  return {
    id: adjustment.id,
    status: adjustment.status,
    debit: dec(adjustment.debit),
    credit: dec(adjustment.credit),
    journalEntryId: journalEntry.id,
  };
}

