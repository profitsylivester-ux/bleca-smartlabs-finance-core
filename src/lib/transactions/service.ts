import { prisma, type Tx } from '@/lib/db/prisma';
import { writeAuditEntry } from '@/lib/audit/writer';
import { runIdempotent } from '@/lib/api/idempotency';
import { withAudit } from '@/lib/db/with-audit';
import { ValidationError, NotFoundError } from '@/lib/kernel/errors';
import { TransactionStateMachine } from '@/lib/workflow/transaction-state-machine';
import type { ActorContext } from '@/lib/kernel/context';

const STATE_MACHINE = new TransactionStateMachine();

export type PaymentMethod = 'CASH' | 'BANK_TRANSFER' | 'CHECK' | 'CREDIT_CARD' | 'DIRECT_DEBIT' | 'OTHER';

interface CreateInput {
  organizationId: string;
  date: Date;
  description?: string;
  reference?: string;
  accountId?: string;
  amount: number;
  currencyCode: string;
  projectId?: string;
  departmentId?: string;
  costCentreId?: string;
  fundingSourceId?: string;
  paymentMethod?: PaymentMethod;
  supportingDocumentId?: string;
}

interface TransactionRow {
  id: string;
  status: string | null;
  date: Date;
  description?: string;
  reference?: string;
  amount: number;
  currencyCode: string;
  paymentMethod: PaymentMethod;
  accountId?: string;
  projectId?: string;
  departmentId?: string;
  costCentreId?: string;
  fundingSourceId?: string;
  supportingDocumentId?: string;
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
        actor,
      },
      async () => {},
      {
        action: 'TRANSACTION_CREATED' as const,
        entityType: 'TRANSACTION' as const,
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
    const where: any = { organizationId };

    if (filters?.status) where.status = filters.status;
    if (filters?.accountId) where.accountId = filters.accountId;
    if (filters?.projectId) where.projectId = filters.projectId;
    if (filters?.departmentId) where.departmentId = filters.departmentId;
    if (filters?.costCentreId) where.costCentreId = filters.costCentreId;
    if (filters?.minAmount !== undefined || filters?.maxAmount !== undefined) {
      where.amount = {};
      if (filters.minAmount !== undefined) where.amount.gte = filters.minAmount;
      if (filters.maxAmount !== undefined) where.amount.lte = filters.maxAmount;
    }
    if (filters?.startDate || filters?.endDate) {
      where.date = {};
      if (filters.startDate) where.date.gte = filters.startDate;
      if (filters.endDate) where.date.lte = filters.endDate;
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

    const updateData: any = {};
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
        actor,
      },
      async () => {},
      {
        action: 'TRANSACTION_UPDATED' as const,
        entityType: 'TRANSACTION' as const,
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
    const outcome = await runIdempotent({
      key: `${id}:submit`,
      scope: `POST /api/v1/transactions/${id}/submit`,
      actorId: actor.userId,
      body: { reason, evidenceDocumentId },
      handler: async (tx: Tx) => { const r = await this._doSubmit(tx, id, organizationId, actor, reason, evidenceDocumentId); return { status: 200, body: r }; },
    });

    if (outcome.kind === 'REPLAYED') {
      return this.findById(id, organizationId) ?? this._throwNotFound(id);
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

    const fromStatus = current.status;

    const isLegal = TransactionStateMachine.isLegalTransition(fromStatus as any, 'SUBMITTED');

    if (!isLegal) {
      const allowed = TransactionStateMachine.getLegalTransitions(fromStatus as any);
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

    return {
      id,
      status: result.newStatus,
      date: new Date(),
      amount: 0,
      currencyCode: 'USD',
      paymentMethod: 'CASH',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  async approve(id: string, organizationId: string, actor: ActorContext): Promise<TransactionRow> {
    const outcome = await runIdempotent({
      key: `${id}:approve`,
      scope: `POST /api/v1/transactions/${id}/approve`,
      actorId: actor.userId,
      body: {},
      handler: async (tx: Tx) => { const r = await this._doAction(tx, id, organizationId, actor, 'APPROVED'); return { status: 200, body: r }; },
    });

    if (outcome.kind === 'REPLAYED') {
      return this.findById(id, organizationId) ?? this._throwNotFound(id);
    }

    return outcome.result;
  }

  async reject(id: string, organizationId: string, actor: ActorContext): Promise<TransactionRow> {
    const outcome = await runIdempotent({
      key: `${id}:reject`,
      scope: `POST /api/v1/transactions/${id}/reject`,
      actorId: actor.userId,
      body: {},
      handler: async (tx: Tx) => this._doAction(tx, id, organizationId, actor, 'REJECTED'),
    });

    if (outcome.kind === 'REPLAYED') {
      return this.findById(id, organizationId) ?? this._throwNotFound(id);
    }

    return outcome.result;
  }

  async post(id: string, organizationId: string, actor: ActorContext): Promise<TransactionRow> {
    const outcome = await runIdempotent({
      key: `${id}:post`,
      scope: `POST /api/v1/transactions/${id}/post`,
      actorId: actor.userId,
      body: {},
      handler: async (tx: Tx) => this._doAction(tx, id, organizationId, actor, 'POSTED'),
    });

    if (outcome.kind === 'REPLAYED') {
      return this.findById(id, organizationId) ?? this._throwNotFound(id);
    }

    return outcome.result;
  }

  async adjust(id: string, organizationId: string, actor: ActorContext, reason: string, evidenceDocumentId?: string): Promise<TransactionRow> {
    const outcome = await runIdempotent({
      key: `${id}:adjust`,
      scope: `POST /api/v1/transactions/${id}/adjust`,
      actorId: actor.userId,
      body: { reason, evidenceDocumentId },
      handler: async (tx: Tx) => this._doAction(tx, id, organizationId, actor, 'ADJUSTED', reason, evidenceDocumentId),
    });

    if (outcome.kind === 'REPLAYED') {
      return this.findById(id, organizationId) ?? this._throwNotFound(id);
    }

    return outcome.result;
  }

  async reverse(id: string, organizationId: string, actor: ActorContext, reason: string, evidenceDocumentId?: string, originalTransactionId?: string): Promise<TransactionRow> {
    const outcome = await runIdempotent({
      key: `${id}:reverse`,
      scope: `POST /api/v1/transactions/${id}/reverse`,
      actorId: actor.userId,
      body: { reason, evidenceDocumentId, originalTransactionId },
      handler: async (tx: Tx) => this._doAction(tx, id, organizationId, actor, 'REVERSED', reason, evidenceDocumentId, originalTransactionId),
    });

    if (outcome.kind === 'REPLAYED') {
      return this.findById(id, organizationId) ?? this._throwNotFound(id);
    }

    return outcome.result;
  }

  async cancel(id: string, organizationId: string, actor: ActorContext, reason?: string): Promise<TransactionRow> {
    const outcome = await runIdempotent({
      key: `${id}:cancel`,
      scope: `POST /api/v1/transactions/${id}/cancel`,
      actorId: actor.userId,
      body: { reason },
      handler: async (tx: Tx) => this._doAction(tx, id, organizationId, actor, 'CANCELLED', reason),
    });

    if (outcome.kind === 'REPLAYED') {
      return this.findById(id, organizationId) ?? this._throwNotFound(id);
    }

    return outcome.result;
  }

  async _doAction(
    tx: Tx,
    id: string,
    organizationId: string,
    actor: ActorContext,
    targetStatus: string,
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

    const fromStatus = current.status;

    const isLegal = TransactionStateMachine.isLegalTransition(fromStatus as any, targetStatus);

    if (!isLegal) {
      const allowed = TransactionStateMachine.getLegalTransitions(fromStatus as any);
      throw new ValidationError(
        `Illegal state transition from ${fromStatus} to ${targetStatus}. Allowed: ${allowed.join(', ')}`,
        { details: { from: fromStatus, to: targetStatus, allowed } },
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
        originalTransactionId,
      },
      targetStatus as any,
    );

    if (!result.success) {
      throw new ValidationError(
        `Illegal state transition from ${result.previousStatus} to ${result.newStatus}`,
        { details: { from: result.previousStatus, to: result.newStatus, allowed: TransactionStateMachine.getLegalTransitions(result.previousStatus) } },
      );
    }

    return {
      id,
      status: result.newStatus,
      date: new Date(),
      amount: 0,
      currencyCode: 'USD',
      paymentMethod: 'CASH',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private _rowFromTransition(id: string, newStatus: any): TransactionRow {
    return {
      id,
      status: newStatus,
      date: new Date(),
      amount: 0,
      currencyCode: 'USD',
      paymentMethod: 'CASH',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private _throwNotFound(id: string) {
    throw new Error(`NotFoundError: Transaction ${id} not found`);
  }
}