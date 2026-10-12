import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma/client';
import { seedTestFixtures } from '../setup/fixtures';
import type { AuditActor } from '@/lib/audit/types';
import {
  approveSession,
  autoMatch,
  confirmMatch,
  createAdjustment,
  recomputeSessionTotals,
  reopenSession,
} from '@/lib/reconciliation/service';

/**
 * M8 reconciliation guarantees (PDF §12).
 *
 * These exercise the service directly rather than through HTTP, because the
 * properties under test are transactional ones: an auto-match that confirmed
 * anything, or an approve that left the difference non-zero, would be invisible
 * to a test that only checked a response body. Driving the service inside one
 * transaction is what lets the difference and the audit row be asserted
 * together.
 */

const prisma = new PrismaClient();

const ACTOR: AuditActor = {
  id: 'm8-recon-test-user',
  name: 'M8 Reconciliation Test User',
  roleCodes: ['FINANCE_MANAGER'],
};

let orgId: string;
let treasuryAccountId: string;
let ledgerAccountId: string;
let adjustmentAccountId: string;
let reasonCodeId: string;

beforeAll(async () => {
  await seedTestFixtures(prisma);

  // The import pipeline and the adjustment both carry real foreign keys onto
  // users, so the actor must exist as a row rather than only as an audit label.
  await prisma.user.create({
    data: {
      id: ACTOR.id ?? 'm8-recon-test-user',
      email: 'm8-recon-test@bleca.test',
      emailNormalized: 'm8-recon-test@bleca.test',
      fullName: ACTOR.name ?? 'M8 Reconciliation Test User',
      status: 'ACTIVE',
    },
  });

  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      reconciliation_adjustments,
      reconciliation_exceptions,
      reconciliation_matches,
      reconciliation_sessions,
      matching_rules,
      import_errors,
      import_rows,
      import_field_mappings,
      import_batches
    RESTART IDENTITY CASCADE
  `);

  const org = await prisma.organization.findFirstOrThrow({
    where: { code: 'BLECA' },
    select: { id: true },
  });
  orgId = org.id;

  const bankLedger = await prisma.account.findFirstOrThrow({
    where: { organizationId: orgId, subCategory: 'BANK', isPostable: true, status: 'ACTIVE' },
    select: { id: true },
  });
  ledgerAccountId = bankLedger.id;

  const expenseLedger = await prisma.account.findFirstOrThrow({
    where: { organizationId: orgId, type: 'EXPENSE', isPostable: true, status: 'ACTIVE' },
    select: { id: true },
  });
  adjustmentAccountId = expenseLedger.id;

  const reasonCode = await prisma.reasonCode.findFirstOrThrow({
    where: { organizationId: orgId, isActive: true },
    select: { id: true },
  });
  reasonCodeId = reasonCode.id;

  const treasury = await prisma.treasuryAccount.create({
    data: {
      organizationId: orgId,
      code: 'BANK-RECON-TEST',
      name: 'Reconciliation Test Bank',
      kind: 'BANK',
      currencyCode: 'TZS',
      ledgerAccountId,
      isRestricted: false,
    },
    select: { id: true },
  });
  treasuryAccountId = treasury.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});
/**
 * Builds a session whose statement and book sides balance exactly once the
 * right matches are confirmed: opening 1000, a 5000 receipt and a 2000 payment,
 * closing 4000. Returning ids rather than asserting here keeps each test to one
 * concern.
 */
let fixtureCounter = 0;

async function createBalancedFixture() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  // A session is unique per (account, period), so each fixture claims its own
  // month rather than colliding with the previous test's June window.
  const month = 1 + (fixtureCounter % 11);
  fixtureCounter += 1;
  const startDate = new Date(Date.UTC(2025, month, 1));
  const endDate = new Date(Date.UTC(2025, month + 1, 0, 23, 59, 59));
  const statementDate = new Date(Date.UTC(2025, month, 5)).toISOString().slice(0, 10);
  const paymentDate = new Date(Date.UTC(2025, month, 10)).toISOString().slice(0, 10);

  const batch = await prisma.importBatch.create({
    data: {
      organizationId: orgId,
      code: `IMP-RECON-${suffix}`,
      source: 'CSV',
      fileName: 'statement.csv',
      fileHash: `hash-${suffix}`,
      fileSize: 1024,
      mimeType: 'text/csv',
      status: 'COMPLETED',
      uploadedById: ACTOR.id ?? 'test-user',
    },
    select: { id: true },
  });

  const rowIn = await prisma.importRow.create({
    data: {
      batchId: batch.id,
      rowNumber: 1,
      status: 'VALID',
      rawData: { date: statementDate, reference: 'INV-2025-001' },
      normalizedData: {
        date: statementDate,
        amount: 5000,
        reference: 'INV-2025-001',
        description: 'Customer payment',
      },
    },
    select: { id: true },
  });

  const rowOut = await prisma.importRow.create({
    data: {
      batchId: batch.id,
      rowNumber: 2,
      status: 'VALID',
      rawData: { date: paymentDate, reference: 'SUP-2025-002' },
      normalizedData: {
        date: paymentDate,
        amount: -2000,
        reference: 'SUP-2025-002',
        description: 'Supplier payment',
      },
    },
    select: { id: true },
  });

  const txnIn = await prisma.transaction.create({
    data: {
      organizationId: orgId,
      status: 'POSTED',
      date: new Date(statementDate),
      amount: 5000,
      currencyCode: 'TZS',
      treasuryAccountId,
      accountId: ledgerAccountId,
      reference: 'INV-2025-001',
      description: 'Customer payment',
      paymentMethod: 'BANK_TRANSFER',
    },
    select: { id: true },
  });

  const txnOut = await prisma.transaction.create({
    data: {
      organizationId: orgId,
      status: 'POSTED',
      date: new Date(paymentDate),
      amount: 2000,
      currencyCode: 'TZS',
      treasuryAccountId,
      accountId: ledgerAccountId,
      reference: 'SUP-2025-002',
      description: 'Supplier payment',
      paymentMethod: 'BANK_TRANSFER',
    },
    select: { id: true },
  });

  const session = await prisma.reconciliationSession.create({
    data: {
      organizationId: orgId,
      code: `RECON-${suffix}`,
      treasuryAccountId,
      importId: batch.id,
      target: 'BANK_STATEMENT',
      currency: 'TZS',
      statementStartDate: startDate,
      statementEndDate: endDate,
      statementOpeningBalance: 1000,
      statementClosingBalance: 4000,
      autoMatchThreshold: 85,
    },
    select: { id: true },
  });

  await prisma.matchingRule.create({
    data: {
      organizationId: orgId,
      name: `EXACT-${suffix}`,
      ruleType: 'EXACT',
      target: 'BANK_STATEMENT',
      priority: 10,
      amountTolerance: 0,
    },
  });

  return {
    sessionId: session.id,
    rowInId: rowIn.id,
    rowOutId: rowOut.id,
    txnInId: txnIn.id,
    txnOutId: txnOut.id,
  };
}

/** Confirms every proposal on a session, so only the gate under test objects. */
async function confirmAll(sessionId: string) {
  const matches = await prisma.reconciliationMatch.findMany({
    where: { sessionId, status: 'PROPOSED' },
    select: { id: true },
  });
  for (const match of matches) {
    await prisma.$transaction((tx) =>
      confirmMatch(tx, { matchId: match.id, organizationId: orgId, actor: ACTOR }),
    );
  }
  return matches.length;
}

describe('M8 Reconciliation', () => {
  it('auto-match creates PROPOSED matches, not auto-confirmed', async () => {
    const { sessionId } = await createBalancedFixture();

    const result = await prisma.$transaction((tx) =>
      autoMatch(tx, { sessionId, organizationId: orgId, actorId: ACTOR.id ?? 'test-user' }),
    );

    expect(result.proposed).toBeGreaterThan(0);

    const matches = await prisma.reconciliationMatch.findMany({
      where: { sessionId },
      select: { status: true, confirmedById: true, confirmedAt: true },
    });

    expect(matches.length).toBeGreaterThan(0);
    // The core guarantee: every row is a proposal, none is asserted.
    for (const match of matches) {
      expect(match.status).toBe('PROPOSED');
      expect(match.confirmedById).toBeNull();
      expect(match.confirmedAt).toBeNull();
    }

    const confirmedCount = await prisma.reconciliationMatch.count({
      where: { sessionId, status: 'MATCHED' },
    });
    expect(confirmedCount).toBe(0);
  });

  it('confirming a match changes its status to MATCHED and recomputes the difference', async () => {
    const { sessionId, rowInId, rowOutId } = await createBalancedFixture();

    await prisma.$transaction((tx) =>
      autoMatch(tx, { sessionId, organizationId: orgId, actorId: ACTOR.id ?? 'test-user' }),
    );

    const before = await recomputeSessionTotals(prisma, sessionId);
    // Proposals contribute nothing, so the difference is still wrong.
    expect(before.unconfirmedCount).toBeGreaterThan(0);
    expect(before.difference.toNumber()).not.toBe(0);

    const inMatch = await prisma.reconciliationMatch.findFirstOrThrow({
      where: { sessionId, importRowId: rowInId },
      select: { id: true },
    });
    const outMatch = await prisma.reconciliationMatch.findFirstOrThrow({
      where: { sessionId, importRowId: rowOutId },
      select: { id: true },
    });

    await prisma.$transaction((tx) =>
      confirmMatch(tx, { matchId: inMatch.id, organizationId: orgId, actor: ACTOR }),
    );
    await prisma.$transaction((tx) =>
      confirmMatch(tx, { matchId: outMatch.id, organizationId: orgId, actor: ACTOR }),
    );

    const inAfter = await prisma.reconciliationMatch.findUniqueOrThrow({
      where: { id: inMatch.id },
      select: { status: true, confirmedById: true, confirmedAt: true },
    });
    expect(inAfter.status).toBe('MATCHED');
    expect(inAfter.confirmedById).toBe(ACTOR.id);
    expect(inAfter.confirmedAt).not.toBeNull();

    const outAfter = await prisma.reconciliationMatch.findUniqueOrThrow({
      where: { id: outMatch.id },
      select: { status: true },
    });
    expect(outAfter.status).toBe('MATCHED');

    // Both legs paired: opening 1000 + (5000 - 2000) = 4000 = statement closing.
    const after = await recomputeSessionTotals(prisma, sessionId);
    expect(after.difference.toNumber()).toBe(0);
    expect(after.matchedCount).toBe(2);
  });

  it('approve is blocked while unconfirmed matches exist', async () => {
    const { sessionId } = await createBalancedFixture();

    await prisma.$transaction((tx) =>
      autoMatch(tx, { sessionId, organizationId: orgId, actorId: ACTOR.id ?? 'test-user' }),
    );

    // Force the difference to zero so this test isolates the confirmation gate.
    await prisma.reconciliationSession.update({
      where: { id: sessionId },
      data: { statementClosingBalance: 1000 },
    });

    await expect(
      prisma.$transaction((tx) =>
        approveSession(tx, { sessionId, organizationId: orgId, actor: ACTOR }),
      ),
    ).rejects.toThrow(/awaiting confirmation/);

    const session = await prisma.reconciliationSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { status: true, approvedById: true },
    });
    expect(session.status).not.toBe('APPROVED');
    expect(session.approvedById).toBeNull();
  });

  it('approve is blocked when the difference is not zero', async () => {
    const { sessionId } = await createBalancedFixture();

    await prisma.$transaction((tx) =>
      autoMatch(tx, { sessionId, organizationId: orgId, actorId: ACTOR.id ?? 'test-user' }),
    );

    await confirmAll(sessionId);

    // Leave a genuine 250 discrepancy against the 4000 closing balance.
    await prisma.reconciliationSession.update({
      where: { id: sessionId },
      data: { statementClosingBalance: 4250 },
    });

    await expect(
      prisma.$transaction((tx) =>
        approveSession(tx, { sessionId, organizationId: orgId, actor: ACTOR }),
      ),
    ).rejects.toThrow(/not zero/);

    const session = await prisma.reconciliationSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { status: true },
    });
    expect(session.status).not.toBe('APPROVED');
  });

  it('adjustment requires a reason code', async () => {
    const { sessionId } = await createBalancedFixture();

    // A missing reason code is refused by the service.
    await expect(
      prisma.$transaction((tx) =>
        createAdjustment(tx, {
          sessionId,
          organizationId: orgId,
          accountId: adjustmentAccountId,
          description: 'Bank charge not in books',
          debit: 250,
          credit: 0,
          reasonCodeId: 'clreasoncodedoesnotexist',
          createdById: ACTOR.id ?? 'test-user',
        }),
      ),
    ).rejects.toThrow(/Reason code/);

    // And the schema refuses it independently of the service, so a future
    // caller that skips validation still cannot persist an unexplained
    // adjustment.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO reconciliation_adjustments
           (id, organization_id, session_id, account_id, description, debit, credit, currency_code, status, created_by_id, created_at, updated_at)
         VALUES (gen_random_uuid(), '${orgId}', '${sessionId}', '${adjustmentAccountId}', 'No reason', 250, 0, 'TZS', 'DRAFT', '${ACTOR.id ?? 'm8-recon-test-user'}', now(), now())`,
      ),
    ).rejects.toThrow();
  });

  it('adjustment with a reason code is balanced and linked to its journal entry', async () => {
    const { sessionId } = await createBalancedFixture();

    const adjustment = await prisma.$transaction((tx) =>
      createAdjustment(tx, {
        sessionId,
        organizationId: orgId,
        accountId: adjustmentAccountId,
        description: 'Bank charge recorded in statement only',
        debit: 250,
        credit: 0,
        reasonCodeId,
        createdById: ACTOR.id ?? 'test-user',
      }),
    );

    expect(adjustment.journalEntryId).toBeTruthy();

    const entry = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: adjustment.journalEntryId },
      include: { lines: true },
    });

    // Balanced: the adjustment leg and the treasury offset cancel exactly.
    const totalDebit = entry.lines.reduce((sum, l) => sum + Number(l.debit), 0);
    const totalCredit = entry.lines.reduce((sum, l) => sum + Number(l.credit), 0);
    expect(totalDebit).toBe(totalCredit);
    expect(entry.lines.length).toBe(2);
    expect(entry.type).toBe('ADJUSTMENT');

    // Linked: the offset lands on the treasury account's own ledger account,
    // which is what makes the difference actually disappear from the books.
    expect(entry.lines.some((l) => l.accountId === ledgerAccountId)).toBe(true);
    expect(entry.lines.some((l) => l.accountId === adjustmentAccountId)).toBe(true);
  });

  it('reopen requires a reason and only works on an approved session', async () => {
    const { sessionId } = await createBalancedFixture();

    // Not approved yet, so a reopen is a conflict rather than a silent no-op.
    await expect(
      prisma.$transaction((tx) =>
        reopenSession(tx, { sessionId, organizationId: orgId, reason: 'Statement was amended' }),
      ),
    ).rejects.toThrow(/APPROVED or LOCKED/);

    await prisma.$transaction((tx) =>
      autoMatch(tx, { sessionId, organizationId: orgId, actorId: ACTOR.id ?? 'test-user' }),
    );
    await confirmAll(sessionId);

    await prisma.$transaction((tx) =>
      approveSession(tx, { sessionId, organizationId: orgId, actor: ACTOR }),
    );

    const approved = await prisma.reconciliationSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { status: true },
    });
    expect(approved.status).toBe('APPROVED');

    // An empty reason is refused before anything is written.
    await expect(
      prisma.$transaction((tx) =>
        reopenSession(tx, { sessionId, organizationId: orgId, reason: '' }),
      ),
    ).rejects.toThrow();

    const reopened = await prisma.$transaction((tx) =>
      reopenSession(tx, {
        sessionId,
        organizationId: orgId,
        reason: 'Bank reissued the June statement with a corrected entry',
      }),
    );

    expect(reopened.status).toBe('REOPENED');
    expect(reopened.reopenCount).toBe(1);
    expect(reopened.reopenReason).toContain('reissued');

    const stored = await prisma.reconciliationSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { reopenReason: true, lockedAt: true },
    });
    expect(stored.reopenReason).toContain('reissued');
    expect(stored.lockedAt).toBeNull();
  });
});

