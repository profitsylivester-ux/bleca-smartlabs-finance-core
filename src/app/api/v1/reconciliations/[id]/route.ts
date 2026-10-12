import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';
import { recomputeSessionTotals } from '@/lib/reconciliation/service';

/**
 * Single reconciliation session with its matches, exceptions and adjustments.
 *
 * Totals are recomputed on read rather than trusted from the stored column: the
 * difference is the number a human signs off against, so it must reflect the
 * matches that exist now, not the ones that existed when the last write ran.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'RECONCILIATION', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const { id } = await params;

    const session = await prisma.reconciliationSession.findFirst({
      where: { id, organizationId: ctx.actor.organizationId },
      select: {
        id: true,
        code: true,
        target: true,
        status: true,
        currency: true,
        statementStartDate: true,
        statementEndDate: true,
        statementOpeningBalance: true,
        statementClosingBalance: true,
        bookBalanceBeginning: true,
        bookBalanceEnding: true,
        calculatedEndingBalance: true,
        difference: true,
        autoMatchThreshold: true,
        matchingRulesApplied: true,
        startedAt: true,
        approvedAt: true,
        approvedById: true,
        reopenedAt: true,
        reopenReason: true,
        reopenCount: true,
        notes: true,
        createdAt: true,
        updatedAt: true,
        treasuryAccount: {
          select: {
            id: true,
            code: true,
            name: true,
            kind: true,
            ledgerAccountId: true,
          },
        },
        matches: {
          orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            matchType: true,
            status: true,
            statementAmount: true,
            ledgerAmount: true,
            matchedAmount: true,
            differenceAmount: true,
            confidence: true,
            isManual: true,
            matchedAt: true,
            confirmedAt: true,
            confirmedById: true,
            rejectionReason: true,
            importRowId: true,
            transactionId: true,
            journalEntryId: true,
          },
        },
        exceptions: {
          orderBy: [{ status: 'asc' }, { severity: 'desc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            exceptionType: true,
            severity: true,
            amount: true,
            description: true,
            suggestedResolution: true,
            status: true,
            resolution: true,
            resolvedAt: true,
            importRowId: true,
            transactionId: true,
          },
        },
        adjustments: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            description: true,
            debit: true,
            credit: true,
            currency: true,
            status: true,
            journalEntryId: true,
            postedAt: true,
            accountId: true,
            reasonCodeId: true,
          },
        },
      },
    });

    if (!session) {
      return apiError(new NotFoundError('Reconciliation session', id), reqId);
    }

    const totals = await prisma.$transaction((tx) => recomputeSessionTotals(tx, id));

    return ok({ data: { session, totals } }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
