import type { Prisma } from '@/generated/prisma/client';
import type { AuditAction } from '@/generated/prisma/client';
import type { InputJsonValue } from '@/generated/prisma/runtime/library';
import { writeAuditEntry } from '@/lib/audit/writer';
import type { AuditActor } from '@/lib/audit/types';
import { ValidationError } from '@/lib/kernel/errors';

export type TransactionStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'APPROVED'
  | 'REJECTED'
  | 'POSTED'
  | 'LOCKED'
  | 'ADJUSTED'
  | 'REVERSED'
  | 'CANCELLED';

export interface TransitionContext {
  tx: Prisma.TransactionClient;
  actor: AuditActor;
  transactionId: string;
  organizationId: string;
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
  sessionId?: string;
  reason?: string;
  evidenceDocumentId?: string;
  originalTransactionId?: string;
}

export interface TransitionResult {
  success: boolean;
  newStatus: TransactionStatus;
  previousStatus: TransactionStatus;
  auditEntryId: string;
}

const LEGAL_TRANSITIONS: Record<TransactionStatus, TransactionStatus[]> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['APPROVED', 'REJECTED', 'DRAFT'],
  APPROVED: ['POSTED', 'REJECTED'],
  REJECTED: ['DRAFT'],
  POSTED: ['LOCKED', 'ADJUSTED', 'REVERSED'],
  LOCKED: ['ADJUSTED', 'REVERSED'],
  ADJUSTED: ['POSTED', 'REVERSED'],
  REVERSED: [],
  CANCELLED: [],
};

const TRANSITION_AUDIT_ACTIONS: Record<string, string> = {
  'DRAFT->SUBMITTED': 'JOURNAL_ENTRY_SUBMITTED',
  'DRAFT->CANCELLED': 'CONFIGURATION_CHANGES',
  'SUBMITTED->APPROVED': 'JOURNAL_ENTRY_APPROVED',
  'SUBMITTED->REJECTED': 'CONFIGURATION_CHANGES',
  'SUBMITTED->DRAFT': 'CONFIGURATION_CHANGES',
  'APPROVED->POSTED': 'JOURNAL_ENTRY_POSTED',
  'APPROVED->REJECTED': 'CONFIGURATION_CHANGES',
  'REJECTED->DRAFT': 'CONFIGURATION_CHANGES',
  'POSTED->LOCKED': 'CONFIGURATION_CHANGES',
  'POSTED->ADJUSTED': 'JOURNAL_ENTRY_UPDATED',
  'POSTED->REVERSED': 'JOURNAL_ENTRY_REVERSED',
  'LOCKED->ADJUSTED': 'JOURNAL_ENTRY_UPDATED',
  'LOCKED->REVERSED': 'JOURNAL_ENTRY_REVERSED',
  'ADJUSTED->POSTED': 'JOURNAL_ENTRY_POSTED',
  'ADJUSTED->REVERSED': 'JOURNAL_ENTRY_REVERSED',
};

export class TransactionStateMachine {
  static isLegalTransition(from: TransactionStatus, to: TransactionStatus): boolean {
    const allowed = LEGAL_TRANSITIONS[from];
    return allowed?.includes(to) ?? false;
  }

  static getLegalTransitions(from: TransactionStatus): TransactionStatus[] {
    return LEGAL_TRANSITIONS[from] ?? [];
  }

  static getAuditAction(from: TransactionStatus, to: TransactionStatus): string {
    return TRANSITION_AUDIT_ACTIONS[`${from}->${to}`] ?? 'SYSTEM';
  }

  async transition(
    ctx: TransitionContext,
    targetStatus: TransactionStatus,
  ): Promise<TransitionResult> {
    const { tx, actor, transactionId, organizationId, requestId, ipAddress, userAgent, sessionId, reason, evidenceDocumentId, originalTransactionId } = ctx;

    const current = await tx.transaction.findFirst({
      where: { id: transactionId, organizationId },
      select: { id: true, status: true, reference: true },
    });

    if (!current) {
      throw new ValidationError(`Transaction ${transactionId} not found`);
    }

    const fromStatus = current.status as TransactionStatus;

    const isLegal = TransactionStateMachine.isLegalTransition(fromStatus, targetStatus);

    const auditAction = TransactionStateMachine.getAuditAction(fromStatus, targetStatus);

    const changes = {
      status: { from: fromStatus, to: targetStatus },
    };

    const metadata: Record<string, InputJsonValue | null> = {
      transactionReference: current.reference ?? current.id,
      isLegalTransition: isLegal,
      transitionType: `${fromStatus}->${targetStatus}`,
    };

    if (reason) metadata.reason = reason;
    if (evidenceDocumentId) metadata.evidenceDocumentId = evidenceDocumentId;
    if (originalTransactionId) metadata.originalTransactionId = originalTransactionId;

    const description = isLegal
      ? `Transaction ${current.reference ?? current.id} transitioned from ${fromStatus} to ${targetStatus}`
      : `ILLEGAL transition attempted: Transaction ${current.reference ?? current.id} from ${fromStatus} to ${targetStatus}`;

    const result = isLegal ? 'SUCCESS' : ('FAILURE' as const);
    const errorMessage = isLegal ? null : `Illegal state transition from ${fromStatus} to ${targetStatus}`;

    const auditResult = await writeAuditEntry(tx, actor, {
      action: auditAction as AuditAction,
      entityType: 'JOURNAL_ENTRY',
      entityId: transactionId,
      entityLabel: current.reference ?? current.id,
      description,
      changes,
      metadata,
      result,
      errorMessage,
      channel: 'WEB',
    }, {
      organizationId,
      requestId,
      ipAddress,
      userAgent,
      sessionId,
    });

    if (!isLegal) {
      throw new ValidationError(
        `Illegal state transition from ${fromStatus} to ${targetStatus}. Allowed: ${LEGAL_TRANSITIONS[fromStatus].join(', ')}`,
        { details: { from: fromStatus, to: targetStatus, allowed: LEGAL_TRANSITIONS[fromStatus] } },
      );
    }

    await tx.transaction.update({
      where: { id: transactionId },
      data: { status: targetStatus },
    });

    return {
      success: true,
      newStatus: targetStatus,
      previousStatus: fromStatus,
      auditEntryId: auditResult.id,
    };
  }
}

export function createTransactionStateMachine(): TransactionStateMachine {
  return new TransactionStateMachine();
}