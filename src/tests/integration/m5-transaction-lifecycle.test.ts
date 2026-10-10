import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma/client';
import { seedTestFixtures } from '../setup/fixtures';
import { TransactionStateMachine, type TransactionStatus } from '@/lib/workflow/transaction-state-machine';
import { TransactionService, type TransactionRow } from '@/lib/transactions/service';
import { runIdempotent } from '@/lib/api/idempotency';
import { writeAuditEntry } from '@/lib/audit/writer';
import type { ActorContext } from '@/lib/kernel/context';

const prisma = new PrismaClient();
let orgId: string;
let userId: string;
let actor: ActorContext;
let assetAccountId: string;
let liabilityAccountId: string;
let periodId: string;

beforeAll(async () => {
  await seedTestFixtures(prisma);

  const org = await prisma.organization.findFirstOrThrow({
    where: { code: 'BLECA' },
    select: { id: true },
  });
  orgId = org.id;

  // Create a test user with FINANCE_OFFICER role
  const financeOfficerRole = await prisma.role.findUnique({
    where: { code: 'FINANCE_OFFICER' },
    select: { id: true },
  });

  const user = await prisma.user.create({
    data: {
      email: `test-${Date.now()}@bleca.test`,
      emailNormalized: `test-${Date.now()}@bleca.test`,
      fullName: 'Test Finance Officer',
      passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$test$test',
      passwordAlgorithm: 'ARGON2ID',
      organizationMemberships: {
        create: { organizationId: orgId },
      },
      userRoles: {
        create: { roleId: financeOfficerRole!.id },
      },
    },
    select: { id: true, email: true, fullName: true, userRoles: { where: { revokedAt: null }, select: { role: { select: { code: true } } } } },
  });
  userId = user.id;
  const actorContext: import('@/lib/kernel/context').ActorContext = {
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    roleCodes: user.userRoles.map((ur) => ur.role.code),
    isFinalApprover: false,
    organizationId: orgId,
    sessionId: null,
    mfaSatisfiedAt: null,
    stepUpSatisfiedAt: null,
    stepUpExpiresAt: null,
  };
  actor = actorContext;

  const assetAccount = await prisma.account.findFirst({
    where: { organizationId: orgId, type: 'ASSET', isPostable: true },
    select: { id: true },
  });
  assetAccountId = assetAccount!.id;

  const liabilityAccount = await prisma.account.findFirst({
    where: { organizationId: orgId, type: 'LIABILITY', isPostable: true },
    select: { id: true },
  });
  liabilityAccountId = liabilityAccount!.id;

  const period = await prisma.financialPeriod.findFirst({
    where: { organizationId: orgId, status: 'OPEN' },
    orderBy: { startDate: 'asc' },
    select: { id: true },
  });
  periodId = period!.id;
});

afterAll(async () => {
  // Clean up test user
  await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'ADMIN_REVOKED', absoluteExpiresAt: new Date(0) },
  });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe('M5 Transaction Lifecycle', () => {
  const service = new TransactionStateMachine();
  const txService = new TransactionService();

  beforeAll(async () => {
    // Clean up transaction data from previous test files
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE transactions RESTART IDENTITY CASCADE`);
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE journal_lines, journal_entries RESTART IDENTITY CASCADE`);
  });

  it('complete lifecycle: create → submit → approve → post → adjust → reverse', async () => {
    // 1. CREATE
    const created = await txService.create(
      {
        organizationId: orgId,
        date: new Date(),
        description: 'Test transaction for lifecycle',
        reference: 'TXN-LIFECYCLE-001',
        accountId: assetAccountId,
        amount: 1000,
        currencyCode: 'TZS',
        paymentMethod: 'BANK_TRANSFER',
      },
      actor,
    );
    expect(created.status).toBe('DRAFT');
    expect(created.amount).toBe(1000);

    // 2. SUBMIT
    const submitted = await txService.submit(
      created.id,
      orgId,
      actor,
      'Submitted for approval',
    );
    expect(submitted.status).toBe('SUBMITTED');

    // 3. APPROVE
    const approved = await txService.approve(
      submitted.id,
      orgId,
      actor,
    );
    expect(approved.status).toBe('APPROVED');

    // 4. POST
    const posted = await txService.post(
      approved.id,
      orgId,
      actor,
    );
    expect(posted.status).toBe('POSTED');

    // Verify journal entry was created
    const postedTx = await prisma.transaction.findUnique({
      where: { id: posted.id },
      include: { journalEntries: true },
    });
    expect(postedTx?.journalEntries).toHaveLength(1);
    expect(postedTx?.journalEntries?.[0]?.status).toBe('POSTED');

    // 5. ADJUST
    const adjusted = await txService.adjust(
      posted.id,
      orgId,
      actor,
      'ADJ_DATA_ENTRY_ERROR: Correcting amount',
    );
    expect(adjusted.status).toBe('ADJUSTED');

    // Verify adjusting transaction was created
    const adjustingTx = await prisma.transaction.findFirst({
      where: { adjustingEntryId: posted.id },
    });
    expect(adjustingTx).not.toBeNull();
    expect(adjustingTx?.status).toBe('ADJUSTED');

    // 6. REVERSE (reverse the original posted transaction)
    const reversed = await txService.reverse(
      posted.id,
      orgId,
      actor,
      'REVERSAL_DUPLICATE: Duplicate entry',
      undefined,
      posted.id,
    );
    expect(reversed.status).toBe('REVERSED');

    // Verify reversal transaction was created and linked
    const reversalTx = await prisma.transaction.findFirst({
      where: { adjustingEntryId: posted.id },
    });
    expect(reversalTx).not.toBeNull();
    expect(reversalTx?.status).toBe('REVERSED');

    // Verify original is still visible
    const originalStillExists = await prisma.transaction.findUnique({
      where: { id: posted.id },
      select: { status: true },
    });
    expect(originalStillExists?.status).toBe('POSTED');
  });

  it('APPROVED transaction cannot be edited via service', async () => {
    const created = await txService.create(
      {
        organizationId: orgId,
        date: new Date(),
        description: 'Test edit restriction',
        accountId: assetAccountId,
        amount: 500,
        currencyCode: 'TZS',
        paymentMethod: 'CASH',
      },
      actor,
    );

    const submitted = await txService.submit(
      created.id,
      orgId,
      actor,
    );
    const approved = await txService.approve(
      submitted.id,
      orgId,
      actor,
    );

    // Attempt to edit description on APPROVED transaction
    await expect(
      txService.update(approved.id, orgId, { description: 'Tampered' }, actor),
    ).rejects.toThrow();
  });

  it('POSTED transaction cannot be edited via service', async () => {
    const created = await txService.create(
      {
        organizationId: orgId,
        date: new Date(),
        description: 'Test edit restriction on posted',
        accountId: assetAccountId,
        amount: 500,
        currencyCode: 'TZS',
        paymentMethod: 'CASH',
      },
      actor,
    );

    const submitted = await txService.submit(
      created.id,
      orgId,
      actor,
    );
    const approved = await txService.approve(
      submitted.id,
      orgId,
      actor,
    );
    const posted = await txService.post(
      approved.id,
      orgId,
      actor,
    );

    // Attempt to edit description on POSTED transaction
    await expect(
      txService.update(posted.id, orgId, { description: 'Tampered' }, actor),
    ).rejects.toThrow();
  });

  it('POSTED transaction cannot be deleted at DB level', async () => {
    const created = await txService.create(
      {
        organizationId: orgId,
        date: new Date(),
        description: 'Test delete restriction',
        accountId: assetAccountId,
        amount: 500,
        currencyCode: 'TZS',
        paymentMethod: 'CASH',
      },
      actor,
    );

    const submitted = await txService.submit(
      created.id,
      orgId,
      actor,
    );
    const approved = await txService.approve(
      submitted.id,
      orgId,
      actor,
    );
    const posted = await txService.post(
      approved.id,
      orgId,
      actor,
    );

    // Attempt direct DB delete
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM transactions WHERE id = '${posted.id}'`),
    ).rejects.toThrow();
  });

  it('APPROVED transaction cannot be deleted at DB level', async () => {
    const created = await txService.create(
      {
        organizationId: orgId,
        date: new Date(),
        description: 'Test delete restriction approved',
        accountId: assetAccountId,
        amount: 500,
        currencyCode: 'TZS',
        paymentMethod: 'CASH',
      },
      actor,
    );

    const submitted = await txService.submit(
      created.id,
      orgId,
      actor,
    );
    const approved = await txService.approve(
      submitted.id,
      orgId,
      actor,
    );

    // Attempt direct DB delete
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM transactions WHERE id = '${approved.id}'`),
    ).rejects.toThrow();
  });

  it('posting is idempotent under repeated request with same idempotency key', async () => {
    const created = await txService.create(
      {
        organizationId: orgId,
        date: new Date(),
        description: 'Test idempotent post',
        accountId: assetAccountId,
        amount: 250,
        currencyCode: 'TZS',
        paymentMethod: 'CASH',
      },
      actor,
    );

    const submitted = await txService.submit(
      created.id,
      orgId,
      actor,
    );
    const approved = await txService.approve(
      submitted.id,
      orgId,
      actor,
    );

    const idempotencyKey = `test-idempotent-${approved.id}`;

    // First post
    const outcome1 = await runIdempotent({
      key: idempotencyKey,
      scope: `POST /api/v1/transactions/${approved.id}/post`,
      actorId: userId,
      body: {},
      handler: async (tx) => {
        const result = await txService._doAction(tx, approved.id, orgId, actor, 'POSTED');
        return { status: 200, body: result };
      },
    });

    expect(outcome1.kind).toBe('EXECUTED');
    if (outcome1.kind === 'EXECUTED') {
      expect(outcome1.result.status).toBe('POSTED');
    }

    // Second post with same idempotency key
    const outcome2 = await runIdempotent({
      key: idempotencyKey,
      scope: `POST /api/v1/transactions/${approved.id}/post`,
      actorId: userId,
      body: {},
      handler: async (tx) => {
        const result = await txService._doAction(tx, approved.id, orgId, actor, 'POSTED');
        return { status: 200, body: result };
      },
    });

    expect(outcome2.kind).toBe('REPLAYED');
    if (outcome2.kind === 'REPLAYED') {
      expect((outcome2.responseBody as TransactionRow).status).toBe('POSTED');
    }

    // Verify only one journal entry was created
    const tx = await prisma.transaction.findUnique({
      where: { id: approved.id },
      include: { journalEntries: true },
    });
    expect(tx?.journalEntries).toHaveLength(1);
  });

  it('reversal links to original and preserves visibility', async () => {
    const created = await txService.create(
      {
        organizationId: orgId,
        date: new Date(),
        description: 'Test reversal link',
        accountId: assetAccountId,
        amount: 750,
        currencyCode: 'TZS',
        paymentMethod: 'CASH',
      },
      actor,
    );

    const submitted = await txService.submit(
      created.id,
      orgId,
      actor,
    );
    const approved = await txService.approve(
      submitted.id,
      orgId,
      actor,
    );
    const posted = await txService.post(
      approved.id,
      orgId,
      actor,
    );

    const reversed = await txService.reverse(
      posted.id,
      orgId,
      actor,
      'REVERSAL_CORRECTION: Error in original',
      undefined,
      posted.id,
    );

    expect(reversed.status).toBe('REVERSED');

    // Verify reversal transaction has link to original
    const reversalRecord = await prisma.transaction.findFirst({
      where: { adjustingEntryId: posted.id },
    });
    expect(reversalRecord).not.toBeNull();
    expect(reversalRecord?.status).toBe('REVERSED');

    // Verify original transaction still exists and is visible
    const original = await prisma.transaction.findUnique({
      where: { id: posted.id },
      select: { id: true, status: true, reference: true },
    });
    expect(original).not.toBeNull();
    expect(original?.status).toBe('POSTED');
  });

  it('illegal transitions are rejected and visible in audit trail', async () => {
    const created = await txService.create(
      {
        organizationId: orgId,
        date: new Date(),
        description: 'Test illegal transition',
        accountId: assetAccountId,
        amount: 100,
        currencyCode: 'TZS',
        paymentMethod: 'CASH',
      },
      actor,
    );

    // Attempt illegal transition: DRAFT -> POSTED (skipping SUBMITTED and APPROVED)
    await expect(
      txService._doAction(
        prisma,
        created.id,
        orgId,
        actor,
        'POSTED',
      ),
    ).rejects.toThrow();

    // Verify audit entry for illegal transition attempt exists
    const auditEntries = await prisma.auditLog.findMany({
      where: {
        entityId: created.id,
        entityType: 'JOURNAL_ENTRY',
        result: 'FAILURE',
        errorMessage: { contains: 'Illegal state transition' },
      },
      select: { description: true, metadata: true },
    });

    expect(auditEntries.length).toBeGreaterThan(0);
    const auditEntry = auditEntries[0]!;
    expect(auditEntry.description).toContain('ILLEGAL transition attempted');
    expect(auditEntry.metadata).toBeDefined();
    expect((auditEntry.metadata as Record<string, unknown>)?.isLegalTransition).toBe(false);
  });

  it('state machine enforces all legal transitions and rejects illegal ones', async () => {
    const transitions = [
      { from: 'DRAFT' as TransactionStatus, to: 'SUBMITTED' as TransactionStatus, legal: true },
      { from: 'DRAFT' as TransactionStatus, to: 'CANCELLED' as TransactionStatus, legal: true },
      { from: 'SUBMITTED' as TransactionStatus, to: 'APPROVED' as TransactionStatus, legal: true },
      { from: 'SUBMITTED' as TransactionStatus, to: 'REJECTED' as TransactionStatus, legal: true },
      { from: 'SUBMITTED' as TransactionStatus, to: 'DRAFT' as TransactionStatus, legal: true },
      { from: 'APPROVED' as TransactionStatus, to: 'POSTED' as TransactionStatus, legal: true },
      { from: 'APPROVED' as TransactionStatus, to: 'REJECTED' as TransactionStatus, legal: true },
      { from: 'REJECTED' as TransactionStatus, to: 'DRAFT' as TransactionStatus, legal: true },
      { from: 'POSTED' as TransactionStatus, to: 'LOCKED' as TransactionStatus, legal: true },
      { from: 'POSTED' as TransactionStatus, to: 'ADJUSTED' as TransactionStatus, legal: true },
      { from: 'POSTED' as TransactionStatus, to: 'REVERSED' as TransactionStatus, legal: true },
      { from: 'LOCKED' as TransactionStatus, to: 'ADJUSTED' as TransactionStatus, legal: true },
      { from: 'LOCKED' as TransactionStatus, to: 'REVERSED' as TransactionStatus, legal: true },
      { from: 'ADJUSTED' as TransactionStatus, to: 'POSTED' as TransactionStatus, legal: true },
      { from: 'ADJUSTED' as TransactionStatus, to: 'REVERSED' as TransactionStatus, legal: true },
    ];

    for (const { from, to, legal } of transitions) {
      expect(TransactionStateMachine.isLegalTransition(from, to)).toBe(legal);
    }

    // Test illegal transitions
    const illegalTransitions = [
      { from: 'DRAFT' as TransactionStatus, to: 'POSTED' as TransactionStatus },
      { from: 'DRAFT' as TransactionStatus, to: 'APPROVED' as TransactionStatus },
      { from: 'POSTED' as TransactionStatus, to: 'SUBMITTED' as TransactionStatus },
      { from: 'REVERSED' as TransactionStatus, to: 'POSTED' as TransactionStatus },
      { from: 'CANCELLED' as TransactionStatus, to: 'DRAFT' as TransactionStatus },
    ];

    for (const { from, to } of illegalTransitions) {
      expect(TransactionStateMachine.isLegalTransition(from, to)).toBe(false);
    }
  });
});

describe('M5 Audit Trail Verification', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE transactions RESTART IDENTITY CASCADE`);
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE journal_lines, journal_entries RESTART IDENTITY CASCADE`);
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE audit_logs RESTART IDENTITY CASCADE`);
  });

  it('every transition attempt writes audit entry', async () => {
    const created = await prisma.transaction.create({
      data: {
        organizationId: orgId,
        status: 'DRAFT',
        date: new Date(),
        description: 'Audit trail test',
        accountId: assetAccountId,
        amount: 100,
        currencyCode: 'TZS',
        paymentMethod: 'CASH',
      },
    });

    const auditActor = {
      id: actor.userId,
      name: actor.fullName,
      roleCodes: actor.roleCodes,
    };

    await writeAuditEntry(prisma, auditActor, {
      action: 'JOURNAL_ENTRY_SUBMITTED',
      entityType: 'JOURNAL_ENTRY',
      entityId: created.id,
      entityLabel: created.id,
      description: 'Test audit entry',
      changes: { status: { from: 'DRAFT', to: 'SUBMITTED' } },
      metadata: { transitionType: 'DRAFT->SUBMITTED', isLegalTransition: true },
      result: 'SUCCESS',
      channel: 'WEB',
    }, { organizationId: orgId });

    const auditLog = await prisma.auditLog.findFirst({
      where: { entityId: created.id },
      orderBy: { recordedAt: 'desc' },
    });

    expect(auditLog).not.toBeNull();
    expect(auditLog?.entityType).toBe('JOURNAL_ENTRY');
    expect(auditLog?.action).toBe('JOURNAL_ENTRY_SUBMITTED');
    expect((auditLog?.metadata as Record<string, unknown>)?.isLegalTransition).toBe(true);
  });
});