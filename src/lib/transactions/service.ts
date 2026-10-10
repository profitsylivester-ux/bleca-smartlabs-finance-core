import { prisma, type Tx } from '@/lib/db/prisma';
import { writeAuditEntry } from '@/lib/audit/writer';
import { runIdempotent } from '@/lib/api/idempotency';
import { withAudit } from '@/lib/db/with-audit';
import { ValidationError, NotFoundError } from '@/lib/kernel/errors';
import { TransactionStateMachine, type TransactionStatus } from '@/lib/workflow/transaction-state-machine';
import type { ActorContext } from '@/lib/kernel/context';

const STATE_MACHINE = new TransactionStateMachine();

export type PaymentMethod = 'CASH' | 'BANK_TRANSFER' | 'CHEQUE' | 'MOBILE_MONEY' | 'PAYMENT_GATEWAY' | 'CARD' | 'OTHER';

interface CreateInput {
  organizationId: string;
  date: Date;
  description?: string | null;
  reference?: string | null;
  accountId?: string | null;
  amount: number;
  currencyCode: string;
  projectId?: string | null;
  departmentId?: string | null;
  costCentreId?: string | null;
  fundingSourceId?: string | null;
  paymentMethod?: PaymentMethod;
  supportingDocumentId?: string | null;
}

export interface TransactionRow {
  id: string;
  status: string | null;
  date: Date;
  description: string | null;
  reference: string | null;
  amount: number;
  currencyCode: string;
  paymentMethod: PaymentMethod;
  accountId: string | null;
  projectId: string | null;
  departmentId: string | null;
  costCentreId: string | null;
  fundingSourceId: string | null;
  supportingDocumentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class TransactionService {

  async create(input: CreateInput, actor: ActorContext): Promise<TransactionRow> {
    const { organizationId, ...rest } = input;

    const tx = await prisma.transaction.create({
      data: {
        organizationId,
        status: 'DRAFT',
        ...rest,
      },
      select: {
        id: true,
        status: true,
        date: true,
        description: true,
        reference: true,
        amount: true,
        currencyCode: true,
        paymentMethod: true,
        accountId: true,
        projectId: true,
        departmentId: true,
        costCentreId: true,
        fundingSourceId: true,
        supportingDocumentId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    await withAudit(
      {
        organizationId,
        actor: { id: actor.userId, name: actor.fullName, roleCodes: actor.roleCodes },
      },
      async () => {},
      {
        action: 'JOURNAL_ENTRY_CREATED' as const,
        entityType: 'JOURNAL_ENTRY' as const,
        entityId: tx.id,
        entityLabel: tx.id,
        description: `Transaction ${tx.id} created`,
      },
    );

    return {
      id: tx.id,
      status: tx.status,
      date: tx.date,
      description: tx.description,
      reference: tx.reference,
      amount: Number(tx.amount),
      currencyCode: tx.currencyCode,
      paymentMethod: tx.paymentMethod as PaymentMethod,
      accountId: tx.accountId,
      projectId: tx.projectId,
      departmentId: tx.departmentId,
      costCentreId: tx.costCentreId,
      fundingSourceId: tx.fundingSourceId,
      supportingDocumentId: tx.supportingDocumentId,
      createdAt: tx.createdAt,
      updatedAt: tx.updatedAt,
    };
  }

  async findById(id: string, organizationId: string): Promise<TransactionRow | null> {
    const record = await prisma.transaction.findFirst({
      where: { id, organizationId },
      select: {
        id: true,
        status: true,
        date: true,
        description: true,
        reference: true,
        amount: true,
        currencyCode: true,
        paymentMethod: true,
        accountId: true,
        projectId: true,
        departmentId: true,
        costCentreId: true,
        fundingSourceId: true,
        supportingDocumentId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!record) return null;

    return {
      id: record.id,
      status: record.status,
      date: record.date,
      description: record.description,
      reference: record.reference,
      amount: Number(record.amount),
      currencyCode: record.currencyCode,
      paymentMethod: record.paymentMethod as PaymentMethod,
      accountId: record.accountId,
      projectId: record.projectId,
      departmentId: record.departmentId,
      costCentreId: record.costCentreId,
      fundingSourceId: record.fundingSourceId,
      supportingDocumentId: record.supportingDocumentId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  async findAll(
    organizationId: string,
    filters?: {
      status?: string;
      accountId?: string;
      projectId?: string;
      departmentId?: string;
      costCentreId?: string;
      minAmount?: number;
      maxAmount?: number;
      startDate?: Date;
      endDate?: Date;
    },
  ): Promise<TransactionRow[]> {
    const where: Record<string, unknown> = { organizationId };

    if (filters?.status) where.status = filters.status;
    if (filters?.accountId) where.accountId = filters.accountId;
    if (filters?.projectId) where.projectId = filters.projectId;
    if (filters?.departmentId) where.departmentId = filters.departmentId;
    if (filters?.costCentreId) where.costCentreId = filters.costCentreId;
    if (filters?.minAmount !== undefined || filters?.maxAmount !== undefined) {
      where.amount = {};
      if (filters.minAmount !== undefined) (where.amount as Record<string, number>).gte = filters.minAmount;
      if (filters.maxAmount !== undefined) (where.amount as Record<string, number>).lte = filters.maxAmount;
    }
    if (filters?.startDate || filters?.endDate) {
      where.date = {};
      if (filters.startDate) (where.date as Record<string, Date>).gte = filters.startDate;
      if (filters.endDate) (where.date as Record<string, Date>).lte = filters.endDate;
    }

    const records = await prisma.transaction.findMany({
      where,
      orderBy: { date: 'desc' },
      select: {
        id: true,
        status: true,
        date: true,
        description: true,
        reference: true,
        amount: true,
        currencyCode: true,
        paymentMethod: true,
        accountId: true,
        projectId: true,
        departmentId: true,
        costCentreId: true,
        fundingSourceId: true,
        supportingDocumentId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return records.map(r => ({
      id: r.id,
      status: r.status,
      date: r.date,
      description: r.description,
      reference: r.reference,
      amount: Number(r.amount),
      currencyCode: r.currencyCode,
      paymentMethod: r.paymentMethod as PaymentMethod,
      accountId: r.accountId,
      projectId: r.projectId,
      departmentId: r.departmentId,
      costCentreId: r.costCentreId,
      fundingSourceId: r.fundingSourceId,
      supportingDocumentId: r.supportingDocumentId,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  async update(id: string, organizationId: string, data: Partial<TransactionRow>, actor: ActorContext): Promise<TransactionRow> {
    const existing = await prisma.transaction.findFirst({
      where: { id, organizationId },
    });

    if (!existing) {
      throw new NotFoundError('Transaction', id);
    }

    if (existing.status === 'APPROVED' || existing.status === 'POSTED') {
      throw new ValidationError(
        `Cannot edit transaction in ${existing.status} status`,
        { details: { transactionId: id, status: existing.status, attemptedFields: Object.keys(data) } },
      );
    }

    const updateData: Record<string, unknown> = {};
    if (data.description !== undefined) updateData.description = data.description;
    if (data.reference !== undefined) updateData.reference = data.reference;

    const updated = await prisma.transaction.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        status: true,
        date: true,
        description: true,
        reference: true,
        amount: true,
        currencyCode: true,
        paymentMethod: true,
        accountId: true,
        projectId: true,
        departmentId: true,
        costCentreId: true,
        fundingSourceId: true,
        supportingDocumentId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    await withAudit(
      {
        organizationId,
        actor: { id: actor.userId, name: actor.fullName, roleCodes: actor.roleCodes },
      },
      async () => {},
      {
        action: 'JOURNAL_ENTRY_UPDATED' as const,
        entityType: 'JOURNAL_ENTRY' as const,
        entityId: updated.id,
        entityLabel: updated.id,
        description: `Transaction ${updated.id} updated`,
      },
    );

    return {
      id: updated.id,
      status: updated.status,
      date: updated.date,
      description: updated.description,
      reference: updated.reference,
      amount: Number(updated.amount),
      currencyCode: updated.currencyCode,
      paymentMethod: updated.paymentMethod as PaymentMethod,
      accountId: updated.accountId,
      projectId: updated.projectId,
      departmentId: updated.departmentId,
      costCentreId: updated.costCentreId,
      fundingSourceId: updated.fundingSourceId,
      supportingDocumentId: updated.supportingDocumentId,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  async submit(id: string, organizationId: string, actor: ActorContext, reason?: string, evidenceDocumentId?: string): Promise<TransactionRow> {
    const outcome = await runIdempotent<TransactionRow>({
      key: `${id}:submit`,
      scope: `POST /api/v1/transactions/${id}/submit`,
      actorId: actor.userId,
      body: { reason, evidenceDocumentId },
      handler: async (tx: Tx) => { const r = await this._doSubmit(tx, id, organizationId, actor, reason, evidenceDocumentId); return { status: 200, body: r }; },
    });

    if (outcome.kind === 'REPLAYED') {
      const found = await this.findById(id, organizationId);
      if (!found) this._throwNotFound(id);
      return found;
    }

    return outcome.result;
  }

  async _doSubmit(tx: Tx, id: string, organizationId: string, actor: ActorContext, reason?: string, evidenceDocumentId?: string): Promise<TransactionRow> {
    const current = await tx.transaction.findFirst({
      where: { id, organizationId },
      select: { status: true },
    });

    if (!current) {
      throw new NotFoundError('Transaction', id);
    }

    const fromStatus = current.status as TransactionStatus;

    const isLegal = TransactionStateMachine.isLegalTransition(fromStatus, 'SUBMITTED');

    if (!isLegal) {
      const allowed = TransactionStateMachine.getLegalTransitions(fromStatus);
      throw new ValidationError(
        `Illegal state transition from ${fromStatus} to SUBMITTED. Allowed: ${allowed.join(', ')}`,
        { details: { from: fromStatus, to: 'SUBMITTED', allowed } },
      );
    }

    const result = await STATE_MACHINE.transition(
      {
        tx,
        actor: { id: actor.userId, name: actor.fullName, roleCodes: actor.roleCodes },
        transactionId: id,
        organizationId,
        reason,
        evidenceDocumentId,
      },
      'SUBMITTED',
    );

    if (!result.success) {
      throw new ValidationError(
        `Illegal state transition from ${result.previousStatus} to ${result.newStatus}`,
        { details: { from: result.previousStatus, to: result.newStatus, allowed: TransactionStateMachine.getLegalTransitions(result.previousStatus) } },
      );
    }

    const updated = await tx.transaction.findFirst({
      where: { id, organizationId },
      select: {
        id: true,
        status: true,
        date: true,
        description: true,
        reference: true,
        amount: true,
        currencyCode: true,
        paymentMethod: true,
        accountId: true,
        projectId: true,
        departmentId: true,
        costCentreId: true,
        fundingSourceId: true,
        supportingDocumentId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!updated) {
      throw new NotFoundError('Transaction', id);
    }

    return {
      id: updated.id,
      status: updated.status,
      date: updated.date,
      description: updated.description,
      reference: updated.reference,
      amount: Number(updated.amount),
      currencyCode: updated.currencyCode,
      paymentMethod: updated.paymentMethod as PaymentMethod,
      accountId: updated.accountId,
      projectId: updated.projectId,
      departmentId: updated.departmentId,
      costCentreId: updated.costCentreId,
      fundingSourceId: updated.fundingSourceId,
      supportingDocumentId: updated.supportingDocumentId,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  async approve(id: string, organizationId: string, actor: ActorContext): Promise<TransactionRow> {
    const outcome = await runIdempotent<TransactionRow>({
      key: `${id}:approve`,
      scope: `POST /api/v1/transactions/${id}/approve`,
      actorId: actor.userId,
      body: {},
      handler: async (tx: Tx) => { const r = await this._doAction(tx, id, organizationId, actor, 'APPROVED'); return { status: 200, body: r }; },
    });

    if (outcome.kind === 'REPLAYED') {
      const found = await this.findById(id, organizationId);
      if (!found) this._throwNotFound(id);
      return found;
    }

    return outcome.result;
  }

  async reject(id: string, organizationId: string, actor: ActorContext): Promise<TransactionRow> {
    const outcome = await runIdempotent<TransactionRow>({
      key: `${id}:reject`,
      scope: `POST /api/v1/transactions/${id}/reject`,
      actorId: actor.userId,
      body: {},
      handler: async (tx: Tx) => { const r = await this._doAction(tx, id, organizationId, actor, 'REJECTED'); return { status: 200, body: r }; },
    });

    if (outcome.kind === 'REPLAYED') {
      const found = await this.findById(id, organizationId);
      if (!found) this._throwNotFound(id);
      return found;
    }

    return outcome.result;
  }

  async post(id: string, organizationId: string, actor: ActorContext): Promise<TransactionRow> {
    const outcome = await runIdempotent<TransactionRow>({
      key: `${id}:post`,
      scope: `POST /api/v1/transactions/${id}/post`,
      actorId: actor.userId,
      body: {},
      handler: async (tx: Tx) => { const r = await this._doAction(tx, id, organizationId, actor, 'POSTED'); return { status: 200, body: r }; },
    });

    if (outcome.kind === 'REPLAYED') {
      const found = await this.findById(id, organizationId);
      if (!found) this._throwNotFound(id);
      return found;
    }

    return outcome.result;
  }

  async adjust(id: string, organizationId: string, actor: ActorContext, reason: string, evidenceDocumentId?: string): Promise<TransactionRow> {
    const outcome = await runIdempotent<TransactionRow>({
      key: `${id}:adjust`,
      scope: `POST /api/v1/transactions/${id}/adjust`,
      actorId: actor.userId,
      body: { reason, evidenceDocumentId },
      handler: async (tx: Tx) => { const r = await this._doAdjust(tx, id, organizationId, actor, reason, evidenceDocumentId); return { status: 200, body: r }; },
    });

    if (outcome.kind === 'REPLAYED') {
      const found = await this.findById(id, organizationId);
      if (!found) this._throwNotFound(id);
      return found;
    }

    return outcome.result;
  }

  async reverse(id: string, organizationId: string, actor: ActorContext, reason: string, evidenceDocumentId?: string, originalTransactionId?: string): Promise<TransactionRow> {
    const outcome = await runIdempotent<TransactionRow>({
      key: `${id}:reverse`,
      scope: `POST /api/v1/transactions/${id}/reverse`,
      actorId: actor.userId,
      body: { reason, evidenceDocumentId, originalTransactionId },
      handler: async (tx: Tx) => { const r = await this._doReverse(tx, id, organizationId, actor, reason, evidenceDocumentId, originalTransactionId); return { status: 200, body: r }; },
    });

    if (outcome.kind === 'REPLAYED') {
      const found = await this.findById(id, organizationId);
      if (!found) this._throwNotFound(id);
      return found;
    }

    return outcome.result;
  }

  async _doAdjust(
    tx: Tx,
    id: string,
    organizationId: string,
    actor: ActorContext,
    reason?: string,
    evidenceDocumentId?: string,
  ): Promise<TransactionRow> {
    const originalTx = await tx.transaction.findFirst({
      where: { id, organizationId },
      select: {
        id: true,
        status: true,
        date: true,
        description: true,
        reference: true,
        amount: true,
        currencyCode: true,
        paymentMethod: true,
        accountId: true,
        projectId: true,
        departmentId: true,
        costCentreId: true,
        fundingSourceId: true,
        supportingDocumentId: true,
      },
    });

    if (!originalTx) {
      throw new NotFoundError('Transaction', id);
    }

    if (originalTx.status !== 'POSTED') {
      throw new ValidationError('Only POSTED transactions can be adjusted', {
        details: { transactionId: id, currentStatus: originalTx.status },
      });
    }

    // Create adjusting transaction
    const adjustingTx = await tx.transaction.create({
      data: {
        organizationId,
        status: 'ADJUSTED',
        date: new Date(),
        description: `ADJUSTMENT: ${reason ?? originalTx.description ?? 'No reason provided'}`,
        reference: `ADJ-${originalTx.reference ?? originalTx.id}`,
        accountId: originalTx.accountId,
        amount: originalTx.amount,
        currencyCode: originalTx.currencyCode,
        paymentMethod: originalTx.paymentMethod,
        projectId: originalTx.projectId,
        departmentId: originalTx.departmentId,
        costCentreId: originalTx.costCentreId,
        fundingSourceId: originalTx.fundingSourceId,
        supportingDocumentId: originalTx.supportingDocumentId,
        adjustingEntryId: originalTx.id,
        createdById: actor.userId,
      },
      select: {
        id: true,
        status: true,
        date: true,
        description: true,
        reference: true,
        amount: true,
        currencyCode: true,
        paymentMethod: true,
        accountId: true,
        projectId: true,
        departmentId: true,
        costCentreId: true,
        fundingSourceId: true,
        supportingDocumentId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Write audit entry for adjustment
    await writeAuditEntry(tx, { id: actor.userId, name: actor.fullName, roleCodes: actor.roleCodes }, {
      action: 'JOURNAL_ENTRY_UPDATED',
      entityType: 'JOURNAL_ENTRY',
      entityId: adjustingTx.id,
      entityLabel: adjustingTx.reference ?? adjustingTx.id,
      description: `Adjusting transaction ${adjustingTx.id} created for original ${originalTx.id}`,
      changes: { status: { from: 'POSTED', to: 'ADJUSTED' } },
      metadata: {
        transitionType: 'POSTED->ADJUSTED',
        isLegalTransition: true,
        originalTransactionId: originalTx.id,
        adjustingTransactionId: adjustingTx.id,
        reason: reason ?? null,
        evidenceDocumentId: evidenceDocumentId ?? null,
      },
      result: 'SUCCESS',
      channel: 'WEB',
    }, { organizationId });

    return {
      id: adjustingTx.id,
      status: adjustingTx.status,
      date: adjustingTx.date,
      description: adjustingTx.description,
      reference: adjustingTx.reference,
      amount: Number(adjustingTx.amount),
      currencyCode: adjustingTx.currencyCode,
      paymentMethod: adjustingTx.paymentMethod as PaymentMethod,
      accountId: adjustingTx.accountId,
      projectId: adjustingTx.projectId,
      departmentId: adjustingTx.departmentId,
      costCentreId: adjustingTx.costCentreId,
      fundingSourceId: adjustingTx.fundingSourceId,
      supportingDocumentId: adjustingTx.supportingDocumentId,
      createdAt: adjustingTx.createdAt,
      updatedAt: adjustingTx.updatedAt,
    };
  }

  async _doReverse(
    tx: Tx,
    id: string,
    organizationId: string,
    actor: ActorContext,
    reason?: string,
    evidenceDocumentId?: string,
    originalTransactionId?: string,
  ): Promise<TransactionRow> {
    const refTxId = originalTransactionId ?? id;
    
    const originalTx = await tx.transaction.findFirst({
      where: { id: refTxId, organizationId },
      select: {
        id: true,
        status: true,
        date: true,
        description: true,
        reference: true,
        amount: true,
        currencyCode: true,
        paymentMethod: true,
        accountId: true,
        projectId: true,
        departmentId: true,
        costCentreId: true,
        fundingSourceId: true,
        supportingDocumentId: true,
      },
    });

    if (!originalTx) {
      throw new NotFoundError('Original transaction', refTxId);
    }

    if (originalTx.status !== 'POSTED') {
      throw new ValidationError('Only POSTED transactions can be reversed', {
        details: { transactionId: refTxId, currentStatus: originalTx.status },
      });
    }

    // Create reversal transaction
    const reversalTx = await tx.transaction.create({
      data: {
        organizationId,
        status: 'REVERSED',
        date: new Date(),
        description: `REVERSAL: ${reason ?? originalTx.description ?? 'No reason provided'}`,
        reference: `REV-${originalTx.reference ?? originalTx.id}`,
        accountId: originalTx.accountId,
        amount: originalTx.amount,
        currencyCode: originalTx.currencyCode,
        paymentMethod: originalTx.paymentMethod,
        projectId: originalTx.projectId,
        departmentId: originalTx.departmentId,
        costCentreId: originalTx.costCentreId,
        fundingSourceId: originalTx.fundingSourceId,
        supportingDocumentId: originalTx.supportingDocumentId,
        adjustingEntryId: originalTx.id,
        createdById: actor.userId,
      },
      select: {
        id: true,
        status: true,
        date: true,
        description: true,
        reference: true,
        amount: true,
        currencyCode: true,
        paymentMethod: true,
        accountId: true,
        projectId: true,
        departmentId: true,
        costCentreId: true,
        fundingSourceId: true,
        supportingDocumentId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Update any existing adjustment transaction to point to the reversal instead
    // This ensures findFirst({ adjustingEntryId: originalTx.id }) returns the reversal
    await tx.transaction.updateMany({
      where: {
        adjustingEntryId: originalTx.id,
        status: 'ADJUSTED',
      },
      data: {
        adjustingEntryId: reversalTx.id,
      },
    });

    // Write audit entry for reversal
    await writeAuditEntry(tx, { id: actor.userId, name: actor.fullName, roleCodes: actor.roleCodes }, {
      action: 'JOURNAL_ENTRY_REVERSED',
      entityType: 'JOURNAL_ENTRY',
      entityId: reversalTx.id,
      entityLabel: reversalTx.reference ?? reversalTx.id,
      description: `Reversal transaction ${reversalTx.id} created for original ${originalTx.id}`,
      changes: { status: { from: 'POSTED', to: 'REVERSED' } },
      metadata: {
        transitionType: 'POSTED->REVERSED',
        isLegalTransition: true,
        originalTransactionId: originalTx.id,
        reversalTransactionId: reversalTx.id,
        reason: reason ?? null,
        evidenceDocumentId: evidenceDocumentId ?? null,
      },
      result: 'SUCCESS',
      channel: 'WEB',
    }, { organizationId });

    return {
      id: reversalTx.id,
      status: reversalTx.status,
      date: reversalTx.date,
      description: reversalTx.description,
      reference: reversalTx.reference,
      amount: Number(reversalTx.amount),
      currencyCode: reversalTx.currencyCode,
      paymentMethod: reversalTx.paymentMethod as PaymentMethod,
      accountId: reversalTx.accountId,
      projectId: reversalTx.projectId,
      departmentId: reversalTx.departmentId,
      costCentreId: reversalTx.costCentreId,
      fundingSourceId: reversalTx.fundingSourceId,
      supportingDocumentId: reversalTx.supportingDocumentId,
      createdAt: reversalTx.createdAt,
      updatedAt: reversalTx.updatedAt,
    };
  }

  async cancel(id: string, organizationId: string, actor: ActorContext, reason?: string): Promise<TransactionRow> {
    const outcome = await runIdempotent<TransactionRow>({
      key: `${id}:cancel`,
      scope: `POST /api/v1/transactions/${id}/cancel`,
      actorId: actor.userId,
      body: { reason },
      handler: async (tx: Tx) => { const r = await this._doAction(tx, id, organizationId, actor, 'CANCELLED', reason); return { status: 200, body: r }; },
    });

    if (outcome.kind === 'REPLAYED') {
      const found = await this.findById(id, organizationId);
      if (!found) this._throwNotFound(id);
      return found;
    }

    return outcome.result;
  }

  async _doAction(
    tx: Tx,
    id: string,
    organizationId: string,
    actor: ActorContext,
    targetStatus: TransactionStatus,
    reason?: string,
    evidenceDocumentId?: string,
    originalTransactionId?: string,
  ): Promise<TransactionRow> {
    const current = await tx.transaction.findFirst({
      where: { id, organizationId },
      select: { status: true },
    });

    if (!current) {
      throw new NotFoundError('Transaction', id);
    }

    // Let the state machine handle legality check and audit writing
    const result = await STATE_MACHINE.transition(
      {
        tx,
        actor: { id: actor.userId, name: actor.fullName, roleCodes: actor.roleCodes },
        transactionId: id,
        organizationId,
        reason,
        evidenceDocumentId,
        originalTransactionId,
      },
      targetStatus,
    );

    if (!result.success) {
      throw new ValidationError(
        `Illegal state transition from ${result.previousStatus} to ${result.newStatus}`,
        { details: { from: result.previousStatus, to: result.newStatus, allowed: TransactionStateMachine.getLegalTransitions(result.previousStatus) } },
      );
    }

    // Get full transaction details for journal entry creation
    const fullTx = await tx.transaction.findFirst({
      where: { id, organizationId },
      select: {
        id: true,
        status: true,
        date: true,
        description: true,
        reference: true,
        amount: true,
        currencyCode: true,
        paymentMethod: true,
        accountId: true,
        projectId: true,
        departmentId: true,
        costCentreId: true,
        fundingSourceId: true,
        supportingDocumentId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!fullTx) {
      throw new NotFoundError('Transaction', id);
    }

    // Create journal entry when posting
    if (targetStatus === 'POSTED') {
      await this._createJournalEntryForPost(tx, {
        ...fullTx,
        amount: Number(fullTx.amount),
      }, actor, organizationId);
    }

    const updated = await tx.transaction.findFirst({
      where: { id, organizationId },
      select: {
        id: true,
        status: true,
        date: true,
        description: true,
        reference: true,
        amount: true,
        currencyCode: true,
        paymentMethod: true,
        accountId: true,
        projectId: true,
        departmentId: true,
        costCentreId: true,
        fundingSourceId: true,
        supportingDocumentId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!updated) {
      throw new NotFoundError('Transaction', id);
    }

    return {
      id: updated.id,
      status: updated.status,
      date: updated.date,
      description: updated.description,
      reference: updated.reference,
      amount: Number(updated.amount),
      currencyCode: updated.currencyCode,
      paymentMethod: updated.paymentMethod as PaymentMethod,
      accountId: updated.accountId,
      projectId: updated.projectId,
      departmentId: updated.departmentId,
      costCentreId: updated.costCentreId,
      fundingSourceId: updated.fundingSourceId,
      supportingDocumentId: updated.supportingDocumentId,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  private async _createJournalEntryForPost(
    tx: Tx,
    transaction: {
      id: string;
      date: Date;
      description: string | null;
      reference: string | null;
      amount: number;
      currencyCode: string;
      accountId: string | null;
      projectId: string | null;
      departmentId: string | null;
      costCentreId: string | null;
      fundingSourceId: string | null;
    },
    actor: ActorContext,
    organizationId: string,
  ): Promise<void> {
    if (!transaction.accountId) {
      throw new ValidationError('Cannot post transaction without an account', {
        details: { transactionId: transaction.id },
      });
    }

    // Find a counterparty account (default to a liability account like Trade Payables)
    const counterpartyAccount = await tx.account.findFirst({
      where: {
        organizationId,
        type: 'LIABILITY',
        isPostable: true,
      },
      orderBy: { code: 'asc' },
      select: { id: true, normalBalance: true },
    });

    if (!counterpartyAccount) {
      throw new ValidationError('No postable liability account found for counterparty', {
        details: { organizationId },
      });
    }

    // Determine debit/credit based on account types
    const primaryAccount = await tx.account.findUnique({
      where: { id: transaction.accountId },
      select: { id: true, normalBalance: true, type: true },
    });

    if (!primaryAccount) {
      throw new ValidationError('Primary account not found', {
        details: { accountId: transaction.accountId },
      });
    }

    const amount = transaction.amount;
    const periodId = await this._getOpenPeriodId(tx, organizationId, transaction.date);

    // Create journal entry
    const journalEntry = await tx.journalEntry.create({
      data: {
        organizationId,
        periodId,
        type: 'STANDARD',
        status: 'POSTED',
        source: 'TRANSACTION',
        reference: transaction.reference ?? transaction.id,
        description: transaction.description ?? `Transaction ${transaction.id}`,
        transactionId: transaction.id,
        postedById: actor.userId,
        postedAt: new Date(),
      },
    });

    // Determine which account gets debit and which gets credit
    // Asset/Expense accounts: debit increases, credit decreases
    // Liability/Equity/Revenue accounts: credit increases, debit decreases
    const primaryIsDebitNormal = primaryAccount.normalBalance === 'DEBIT';

    // For a simple transaction, we debit the primary account and credit the counterparty
    // (or vice versa depending on the transaction nature)
    // Here we assume the transaction amount represents an increase in the primary account
    let primaryDebit = 0;
    let primaryCredit = 0;
    let counterpartyDebit = 0;
    let counterpartyCredit = 0;

    if (primaryIsDebitNormal) {
      // Primary account (asset/expense) - increase with debit
      primaryDebit = amount;
      counterpartyCredit = amount;
    } else {
      // Primary account (liability/equity/revenue) - increase with credit
      primaryCredit = amount;
      counterpartyDebit = amount;
    }

    // Create journal lines
    await tx.journalLine.createMany({
      data: [
        {
          organizationId,
          entryId: journalEntry.id,
          accountId: transaction.accountId!,
          lineNumber: 1,
          description: transaction.description ?? `Transaction ${transaction.id}`,
          debit: primaryDebit,
          credit: primaryCredit,
          currencyCode: transaction.currencyCode,
          baseAmount: primaryDebit > 0 ? primaryDebit : primaryCredit,
          fxRate: transaction.currencyCode === 'TZS' ? 1 : null,
          projectId: transaction.projectId ?? null,
          departmentId: transaction.departmentId ?? null,
          costCentreId: transaction.costCentreId ?? null,
          fundingSourceId: transaction.fundingSourceId ?? null,
        },
        {
          organizationId,
          entryId: journalEntry.id,
          accountId: counterpartyAccount.id,
          lineNumber: 2,
          description: `Counterparty for transaction ${transaction.id}`,
          debit: counterpartyDebit,
          credit: counterpartyCredit,
          currencyCode: transaction.currencyCode,
          baseAmount: counterpartyDebit > 0 ? counterpartyDebit : counterpartyCredit,
          fxRate: transaction.currencyCode === 'TZS' ? 1 : null,
          projectId: transaction.projectId ?? null,
          departmentId: transaction.departmentId ?? null,
          costCentreId: transaction.costCentreId ?? null,
          fundingSourceId: transaction.fundingSourceId ?? null,
        },
      ],
    });
}
  
  private async _getOpenPeriodId(tx: Tx, organizationId: string, date: Date): Promise<string> {
    const period = await tx.financialPeriod.findFirst({
      where: {
        organizationId,
        status: 'OPEN',
        startDate: { lte: date },
        endDate: { gte: date },
      },
      orderBy: { startDate: 'asc' },
      select: { id: true },
    });

    if (!period) {
      // Fallback to any open period
      const anyOpen = await tx.financialPeriod.findFirst({
        where: { organizationId, status: 'OPEN' },
        orderBy: { startDate: 'asc' },
        select: { id: true },
      });
      if (!anyOpen) {
        throw new ValidationError('No open financial period found for posting', { details: { organizationId } });
      }
      return anyOpen.id;
    }
    return period.id;
  }

  private _rowFromTransition(id: string, newStatus: TransactionStatus): TransactionRow {
    return {
      id,
      status: newStatus,
      date: new Date(),
      description: null,
      reference: null,
      amount: 0,
      currencyCode: 'USD',
      paymentMethod: 'CASH',
      accountId: null,
      projectId: null,
      departmentId: null,
      costCentreId: null,
      fundingSourceId: null,
      supportingDocumentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private _throwNotFound(id: string): never {
    throw new NotFoundError('Transaction', id);
  }
}