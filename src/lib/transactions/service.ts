import { prisma, type Tx } from '@/lib/db/prisma';
import { writeAuditEntry } from '@/lib/audit/writer';
import { runIdempotent } from '@/lib/api/idempotency';
import { withAudit } from '@/lib/db/with-audit';
import { ValidationError, NotFoundError } from '@/lib/kernel/errors';
import { TransactionStateMachine, type TransactionStatus } from '@/lib/workflow/transaction-state-machine';
import type { ActorContext } from '@/lib/kernel/context';
import type { AuditActor } from '@/lib/audit/types';

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
      handler: async (tx: Tx) => { const r = await this._doAction(tx, id, organizationId, actor, 'ADJUSTED', reason, evidenceDocumentId); return { status: 200, body: r }; },
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
      handler: async (tx: Tx) => { const r = await this._doAction(tx, id, organizationId, actor, 'REVERSED', reason, evidenceDocumentId, originalTransactionId); return { status: 200, body: r }; },
    });

    if (outcome.kind === 'REPLAYED') {
      const found = await this.findById(id, organizationId);
      if (!found) this._throwNotFound(id);
      return found;
    }

    return outcome.result;
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

    const fromStatus = current.status as TransactionStatus;

    const isLegal = TransactionStateMachine.isLegalTransition(fromStatus, targetStatus);

    if (!isLegal) {
      const allowed = TransactionStateMachine.getLegalTransitions(fromStatus);
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
      targetStatus,
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