import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { TransactionStateMachine, type TransactionStatus } from '@/lib/workflow/transaction-state-machine';
import { ValidationError } from '@/lib/kernel/errors';

const mockTx = {
  transaction: {
    findFirst: vi.fn(),
    update: vi.fn(),
  },
};

vi.mock('@/lib/audit/writer', () => ({
  writeAuditEntry: vi.fn().mockResolvedValue({ id: 'audit-1', sequence: 1n, entryHash: 'hash' }),
  SYSTEM_ACTOR: { id: null, name: 'system', roleCodes: ['SYSTEM'] },
}));

import { writeAuditEntry } from '@/lib/audit/writer';

const actor = { id: 'user-1', name: 'Test User', roleCodes: ['FINANCE_OFFICER'] };
const baseContext = {
  tx: mockTx as unknown as Prisma.TransactionClient,
  actor,
  transactionId: 'txn-1',
  organizationId: 'org-1',
  requestId: 'req-1',
  ipAddress: '127.0.0.1',
  userAgent: 'test-agent',
  sessionId: 'session-1',
};

describe('TransactionStateMachine', () => {
  let machine: TransactionStateMachine;

  beforeEach(() => {
    vi.clearAllMocks();
    machine = new TransactionStateMachine();
    mockTx.transaction.findFirst.mockReset();
    mockTx.transaction.update.mockReset();
  });

  describe('isLegalTransition', () => {
    const legalTransitions: [TransactionStatus, TransactionStatus][] = [
      ['DRAFT', 'SUBMITTED'],
      ['DRAFT', 'CANCELLED'],
      ['SUBMITTED', 'APPROVED'],
      ['SUBMITTED', 'REJECTED'],
      ['SUBMITTED', 'DRAFT'],
      ['APPROVED', 'POSTED'],
      ['APPROVED', 'REJECTED'],
      ['REJECTED', 'DRAFT'],
      ['POSTED', 'LOCKED'],
      ['POSTED', 'ADJUSTED'],
      ['POSTED', 'REVERSED'],
      ['LOCKED', 'ADJUSTED'],
      ['LOCKED', 'REVERSED'],
      ['ADJUSTED', 'POSTED'],
      ['ADJUSTED', 'REVERSED'],
    ];

    it.each(legalTransitions)('allows %s -> %s', (from, to) => {
      expect(TransactionStateMachine.isLegalTransition(from, to)).toBe(true);
    });

    const illegalTransitions: [TransactionStatus, TransactionStatus][] = [
      ['DRAFT', 'APPROVED'],
      ['DRAFT', 'POSTED'],
      ['DRAFT', 'LOCKED'],
      ['DRAFT', 'ADJUSTED'],
      ['DRAFT', 'REVERSED'],
      ['SUBMITTED', 'POSTED'],
      ['SUBMITTED', 'LOCKED'],
      ['SUBMITTED', 'ADJUSTED'],
      ['SUBMITTED', 'REVERSED'],
      ['SUBMITTED', 'CANCELLED'],
      ['APPROVED', 'DRAFT'],
      ['APPROVED', 'LOCKED'],
      ['APPROVED', 'ADJUSTED'],
      ['APPROVED', 'REVERSED'],
      ['APPROVED', 'CANCELLED'],
      ['REJECTED', 'SUBMITTED'],
      ['REJECTED', 'APPROVED'],
      ['REJECTED', 'POSTED'],
      ['REJECTED', 'LOCKED'],
      ['REJECTED', 'ADJUSTED'],
      ['REJECTED', 'REVERSED'],
      ['REJECTED', 'CANCELLED'],
      ['POSTED', 'DRAFT'],
      ['POSTED', 'SUBMITTED'],
      ['POSTED', 'APPROVED'],
      ['POSTED', 'REJECTED'],
      ['POSTED', 'CANCELLED'],
      ['LOCKED', 'DRAFT'],
      ['LOCKED', 'SUBMITTED'],
      ['LOCKED', 'APPROVED'],
      ['LOCKED', 'REJECTED'],
      ['LOCKED', 'POSTED'],
      ['LOCKED', 'CANCELLED'],
      ['ADJUSTED', 'DRAFT'],
      ['ADJUSTED', 'SUBMITTED'],
      ['ADJUSTED', 'APPROVED'],
      ['ADJUSTED', 'REJECTED'],
      ['ADJUSTED', 'LOCKED'],
      ['ADJUSTED', 'CANCELLED'],
      ['REVERSED', 'DRAFT'],
      ['REVERSED', 'SUBMITTED'],
      ['REVERSED', 'APPROVED'],
      ['REVERSED', 'REJECTED'],
      ['REVERSED', 'POSTED'],
      ['REVERSED', 'LOCKED'],
      ['REVERSED', 'ADJUSTED'],
      ['REVERSED', 'CANCELLED'],
      ['CANCELLED', 'DRAFT'],
      ['CANCELLED', 'SUBMITTED'],
      ['CANCELLED', 'APPROVED'],
      ['CANCELLED', 'REJECTED'],
      ['CANCELLED', 'POSTED'],
      ['CANCELLED', 'LOCKED'],
      ['CANCELLED', 'ADJUSTED'],
      ['CANCELLED', 'REVERSED'],
    ];

    it.each(illegalTransitions)('rejects %s -> %s', (from, to) => {
      expect(TransactionStateMachine.isLegalTransition(from, to)).toBe(false);
    });
  });

  describe('getLegalTransitions', () => {
    it('returns correct transitions for DRAFT', () => {
      expect(TransactionStateMachine.getLegalTransitions('DRAFT')).toEqual(['SUBMITTED', 'CANCELLED']);
    });

    it('returns correct transitions for SUBMITTED', () => {
      expect(TransactionStateMachine.getLegalTransitions('SUBMITTED')).toEqual(['APPROVED', 'REJECTED', 'DRAFT']);
    });

    it('returns correct transitions for APPROVED', () => {
      expect(TransactionStateMachine.getLegalTransitions('APPROVED')).toEqual(['POSTED', 'REJECTED']);
    });

    it('returns correct transitions for REJECTED', () => {
      expect(TransactionStateMachine.getLegalTransitions('REJECTED')).toEqual(['DRAFT']);
    });

    it('returns correct transitions for POSTED', () => {
      expect(TransactionStateMachine.getLegalTransitions('POSTED')).toEqual(['LOCKED', 'ADJUSTED', 'REVERSED']);
    });

    it('returns correct transitions for LOCKED', () => {
      expect(TransactionStateMachine.getLegalTransitions('LOCKED')).toEqual(['ADJUSTED', 'REVERSED']);
    });

    it('returns correct transitions for ADJUSTED', () => {
      expect(TransactionStateMachine.getLegalTransitions('ADJUSTED')).toEqual(['POSTED', 'REVERSED']);
    });

    it('returns empty array for terminal states', () => {
      expect(TransactionStateMachine.getLegalTransitions('REVERSED')).toEqual([]);
      expect(TransactionStateMachine.getLegalTransitions('CANCELLED')).toEqual([]);
    });
  });

  describe('transition', () => {
    beforeEach(() => {
      mockTx.transaction.findFirst.mockResolvedValue({
        id: 'txn-1',
        status: 'DRAFT',
        number: 'TXN-001',
      });
      mockTx.transaction.update.mockResolvedValue({});
    });

    it('successfully transitions DRAFT -> SUBMITTED', async () => {
      const result = await machine.transition({ ...baseContext, reason: 'Ready for review' }, 'SUBMITTED');

      expect(result.success).toBe(true);
      expect(result.newStatus).toBe('SUBMITTED');
      expect(result.previousStatus).toBe('DRAFT');
      expect(mockTx.transaction.update).toHaveBeenCalledWith({
        where: { id: 'txn-1' },
        data: { status: 'SUBMITTED' },
      });
      expect(writeAuditEntry).toHaveBeenCalled();
    });

    it('successfully transitions SUBMITTED -> APPROVED', async () => {
      mockTx.transaction.findFirst.mockResolvedValue({
        id: 'txn-1',
        status: 'SUBMITTED',
        number: 'TXN-001',
      });

      const result = await machine.transition(baseContext, 'APPROVED');

      expect(result.success).toBe(true);
      expect(result.newStatus).toBe('APPROVED');
      expect(result.previousStatus).toBe('SUBMITTED');
    });

    it('successfully transitions APPROVED -> POSTED', async () => {
      mockTx.transaction.findFirst.mockResolvedValue({
        id: 'txn-1',
        status: 'APPROVED',
        number: 'TXN-001',
      });

      const result = await machine.transition(baseContext, 'POSTED');

      expect(result.success).toBe(true);
      expect(result.newStatus).toBe('POSTED');
      expect(result.previousStatus).toBe('APPROVED');
    });

    it('successfully transitions POSTED -> REVERSED', async () => {
      mockTx.transaction.findFirst.mockResolvedValue({
        id: 'txn-1',
        status: 'POSTED',
        number: 'TXN-001',
      });

      const result = await machine.transition(
        { ...baseContext, reason: 'Duplicate entry', originalTransactionId: 'txn-1' },
        'REVERSED',
      );

      expect(result.success).toBe(true);
      expect(result.newStatus).toBe('REVERSED');
      expect(result.previousStatus).toBe('POSTED');
    });

    it('rejects illegal transition DRAFT -> POSTED', async () => {
      await expect(machine.transition(baseContext, 'POSTED')).rejects.toThrow(ValidationError);
      await expect(machine.transition(baseContext, 'POSTED')).rejects.toThrow(/Illegal state transition/);

      expect(mockTx.transaction.update).not.toHaveBeenCalled();
      expect(writeAuditEntry).toHaveBeenCalled();
    });

    it('rejects illegal transition APPROVED -> DRAFT', async () => {
      mockTx.transaction.findFirst.mockResolvedValue({
        id: 'txn-1',
        status: 'APPROVED',
        number: 'TXN-001',
      });

      await expect(machine.transition(baseContext, 'DRAFT')).rejects.toThrow(ValidationError);
      expect(mockTx.transaction.update).not.toHaveBeenCalled();
    });

    it('rejects transition from terminal state REVERSED', async () => {
      mockTx.transaction.findFirst.mockResolvedValue({
        id: 'txn-1',
        status: 'REVERSED',
        number: 'TXN-001',
      });

      await expect(machine.transition(baseContext, 'POSTED')).rejects.toThrow(ValidationError);
      expect(mockTx.transaction.update).not.toHaveBeenCalled();
    });

    it('rejects transition from terminal state CANCELLED', async () => {
      mockTx.transaction.findFirst.mockResolvedValue({
        id: 'txn-1',
        status: 'CANCELLED',
        number: 'TXN-001',
      });

      await expect(machine.transition(baseContext, 'DRAFT')).rejects.toThrow(ValidationError);
      expect(mockTx.transaction.update).not.toHaveBeenCalled();
    });

    it('writes audit entry for illegal transition attempts', async () => {
      await expect(machine.transition(baseContext, 'POSTED')).rejects.toThrow();

      expect(writeAuditEntry).toHaveBeenCalledWith(
        mockTx,
        actor,
        expect.objectContaining({
          result: 'FAILURE',
          errorMessage: expect.stringContaining('Illegal state transition'),
        }),
        expect.any(Object),
      );
    });

    it('writes audit entry for successful transition', async () => {
      await machine.transition({ ...baseContext, reason: 'Submitting for approval' }, 'SUBMITTED');

      expect(writeAuditEntry).toHaveBeenCalledWith(
        mockTx,
        actor,
        expect.objectContaining({
          result: 'SUCCESS',
          errorMessage: null,
          description: expect.stringContaining('transitioned from DRAFT to SUBMITTED'),
        }),
        expect.any(Object),
      );
    });

    it('includes reason and evidence in audit metadata', async () => {
      await machine.transition(
        { ...baseContext, reason: 'Amount corrected', evidenceDocumentId: 'doc-1' },
        'SUBMITTED',
      );

      expect(writeAuditEntry).toHaveBeenCalledWith(
        mockTx,
        actor,
        expect.objectContaining({
          metadata: expect.objectContaining({
            reason: 'Amount corrected',
            evidenceDocumentId: 'doc-1',
          }),
        }),
        expect.any(Object),
      );
    });

    it('throws ValidationError when transaction does not exist', async () => {
      mockTx.transaction.findFirst.mockResolvedValue(null);

      await expect(machine.transition(baseContext, 'SUBMITTED')).rejects.toThrow(ValidationError);
      await expect(machine.transition(baseContext, 'SUBMITTED')).rejects.toThrow(/not found/);
    });
  });
});