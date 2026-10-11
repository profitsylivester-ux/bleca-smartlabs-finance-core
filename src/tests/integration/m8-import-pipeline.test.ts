import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, TransactionStatus, VerificationStatus, JournalEntryType, JournalEntryStatus, JournalSource } from '@/generated/prisma/client';
import { seedTestFixtures } from '../setup/fixtures';
import { createHash } from 'crypto';

const prisma = new PrismaClient();
let orgId: string;
let userId: string;
let periodId: string;
let bankAccountId: string;
let liabilityAccountId: string;

async function createTestUser(): Promise<string> {
  const ceoRole = await prisma.role.findUnique({ where: { code: 'CEO' }, select: { id: true } });
  const user = await prisma.user.create({
    data: {
      email: `test-import-${Date.now()}@bleca.finance`,
      emailNormalized: `test-import-${Date.now()}@bleca.finance`.toLowerCase(),
      fullName: 'Import Test User',
      passwordHash: 'dummy',
      organizationMemberships: {
        create: { organizationId: orgId },
      },
      userRoles: {
        create: { roleId: ceoRole!.id },
      },
    },
    select: { id: true },
  });
  return user.id;
}

async function uploadStatementFile(fileContent: string, fileName: string, source: 'CSV' | 'EXCEL' | 'API' | 'MANUAL' = 'CSV'): Promise<{ id: string; code: string }> {
  const fileBuffer = Buffer.from(fileContent);
  const fileHash = createHash('sha256').update(fileBuffer).digest('hex');
  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer]));
  formData.append('fileName', fileName);
  formData.append('fileSize', fileBuffer.length.toString());
  formData.append('mimeType', 'text/csv');
  formData.append('source', source);
  formData.append('fileHash', fileHash);

  const response = await fetch(`http://localhost:3000/api/v1/imports/statement/upload`, {
    method: 'POST',
    body: formData,
    headers: {
      'x-test-user-id': userId,
      'x-test-org-id': orgId,
    },
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Upload failed: ${JSON.stringify(error)}`);
  }
  return response.json().then(r => r.data);
}

async function createMapping(batchId: string): Promise<void> {
  const mapping = {
    name: 'Test CSV Mapping',
    dateFormat: 'yyyy-MM-dd',
    amountConvention: 'SINGLE_DEBIT_CREDIT',
    decimalSeparator: '.',
    thousandSeparator: ',',
    encoding: 'UTF-8',
    hasHeader: true,
    columnMap: { date: 0, description: 1, debit: 2, credit: 3, reference: 4 },
  };

  const response = await fetch(`http://localhost:3000/api/v1/imports/${batchId}/mapping`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `test-mapping-${batchId}`,
      'x-test-user-id': userId,
      'x-test-org-id': orgId,
    },
    body: JSON.stringify(mapping),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Mapping failed: ${JSON.stringify(error)}`);
  }
}

async function validateImport(batchId: string): Promise<{ validCount: number; errorCount: number }> {
  const response = await fetch(`http://localhost:3000/api/v1/imports/${batchId}/validate`, {
    method: 'POST',
    headers: {
      'Idempotency-Key': `test-validate-${batchId}`,
      'x-test-user-id': userId,
      'x-test-org-id': orgId,
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Validation failed: ${JSON.stringify(error)}`);
  }
  return response.json().then(r => r.data);
}

async function previewImport(batchId: string): Promise<{ rows: any[]; summary: any }> {
  const response = await fetch(`http://localhost:3000/api/v1/imports/${batchId}/preview`, {
    method: 'GET',
    headers: {
      'x-test-user-id': userId,
      'x-test-org-id': orgId,
    },
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Preview failed: ${JSON.stringify(error)}`);
  }
  return response.json().then(r => r.data);
}

async function detectDuplicates(batchId: string): Promise<{ results: any[]; summary: any }> {
  const response = await fetch(`http://localhost:3000/api/v1/imports/${batchId}/detect-duplicates`, {
    method: 'POST',
    headers: {
      'Idempotency-Key': `test-detect-duplicates-${batchId}`,
      'x-test-user-id': userId,
      'x-test-org-id': orgId,
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Detect duplicates failed: ${JSON.stringify(error)}`);
  }
  return response.json().then(r => r.data);
}

async function approveImport(batchId: string): Promise<void> {
  const response = await fetch(`http://localhost:3000/api/v1/imports/${batchId}/approve`, {
    method: 'POST',
    headers: {
      'Idempotency-Key': `test-approve-${batchId}`,
      'x-test-user-id': userId,
      'x-test-org-id': orgId,
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Approve failed: ${JSON.stringify(error)}`);
  }
}

async function commitImport(batchId: string): Promise<{ results: any[]; summary: any }> {
  const response = await fetch(`http://localhost:3000/api/v1/imports/${batchId}/commit`, {
    method: 'POST',
    headers: {
      'Idempotency-Key': `test-commit-${batchId}`,
      'x-test-user-id': userId,
      'x-test-org-id': orgId,
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Commit failed: ${JSON.stringify(error)}`);
  }
  return response.json().then(r => r.data);
}

async function rollbackImport(batchId: string): Promise<{ deletedTransactions: number; deletedJournalEntries: number }> {
  const response = await fetch(`http://localhost:3000/api/v1/imports/${batchId}/rollback`, {
    method: 'POST',
    headers: {
      'Idempotency-Key': `test-rollback-${batchId}`,
      'x-test-user-id': userId,
      'x-test-org-id': orgId,
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Rollback failed: ${JSON.stringify(error)}`);
  }
  return response.json().then(r => r.data);
}

beforeAll(async () => {
  await seedTestFixtures(prisma);

  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      journal_lines, journal_entries, transactions, import_errors, import_rows, import_batches, import_field_mappings
    RESTART IDENTITY CASCADE
  `);

  const org = await prisma.organization.findFirstOrThrow({
    where: { code: 'BLECA' },
    select: { id: true },
  });
  orgId = org.id;

  userId = await createTestUser();

  periodId = (await prisma.financialPeriod.findFirst({
    where: { organizationId: orgId, status: 'OPEN' },
    orderBy: { startDate: 'asc' },
    select: { id: true },
  }))!.id;

  const bankAccount = await prisma.account.findFirst({
    where: { organizationId: orgId, type: 'ASSET', subCategory: 'BANK', isPostable: true, status: 'ACTIVE' },
    orderBy: { code: 'asc' },
    select: { id: true },
  });
  bankAccountId = bankAccount!.id;

  liabilityAccountId = (await prisma.account.findFirst({
    where: { organizationId: orgId, type: 'LIABILITY', isPostable: true },
    orderBy: { code: 'asc' },
    select: { id: true },
  }))!.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('M8 Import Pipeline', () => {
  describe('Stage Gates', () => {
    it('blocks preview before validation', async () => {
      const csv = `Date,Description,Debit,Credit,Reference
2025-01-15,Test Transaction,100000,0,REF-001
`;
      const { id: batchId } = await uploadStatementFile(csv, 'test-before-validation.csv');
      await createMapping(batchId);

      const previewResp = await fetch(`http://localhost:3000/api/v1/imports/${batchId}/preview`, {
        method: 'GET',
        headers: { 'x-test-user-id': userId, 'x-test-org-id': orgId },
      });
      expect(previewResp.status).toBe(400);
      const error = await previewResp.json();
      expect(error.error.message).toMatch(/Preview not available|Complete validation first/);
    });

    it('blocks commit before approval', async () => {
      const csv = `Date,Description,Debit,Credit,Reference
2025-01-15,Test Transaction,100000,0,REF-002
`;
      const { id: batchId } = await uploadStatementFile(csv, 'test-before-approval.csv');
      await createMapping(batchId);
      await validateImport(batchId);
      await detectDuplicates(batchId);

      const commitResp = await fetch(`http://localhost:3000/api/v1/imports/${batchId}/commit`, {
        method: 'POST',
        headers: {
          'Idempotency-Key': `test-commit-${batchId}`,
          'x-test-user-id': userId,
          'x-test-org-id': orgId,
        },
        body: JSON.stringify({}),
      });
      expect(commitResp.status).toBe(400);
      const error = await commitResp.json();
      expect(error.error.message).toMatch(/Cannot commit in .* status. Approve first/);
    });

    it('blocks approve with unresolved errors', async () => {
      const csv = `Date,Description,Debit,Credit,Reference
invalid-date,Bad Date,100000,0,REF-003
`;
      const { id: batchId } = await uploadStatementFile(csv, 'test-errors.csv');
      await createMapping(batchId);
      await validateImport(batchId);
      await detectDuplicates(batchId);

      const approveResp = await fetch(`http://localhost:3000/api/v1/imports/${batchId}/approve`, {
        method: 'POST',
        headers: {
          'Idempotency-Key': `test-approve-${batchId}`,
          'x-test-user-id': userId,
          'x-test-org-id': orgId,
        },
        body: JSON.stringify({}),
      });
      expect(approveResp.status).toBe(400);
      const error = await approveResp.json();
      expect(error.error.message).toMatch(/unresolved errors/);
    });

    it('blocks approve with unresolved duplicates', async () => {
      const csv = `Date,Description,Debit,Credit,Reference
2025-01-15,Duplicate Row,100000,0,REF-004
2025-01-15,Duplicate Row,100000,0,REF-004
`;
      const { id: batchId } = await uploadStatementFile(csv, 'test-duplicates.csv');
      await createMapping(batchId);
      await validateImport(batchId);
      await detectDuplicates(batchId);

      const approveResp = await fetch(`http://localhost:3000/api/v1/imports/${batchId}/approve`, {
        method: 'POST',
        headers: {
          'Idempotency-Key': `test-approve-${batchId}`,
          'x-test-user-id': userId,
          'x-test-org-id': orgId,
        },
        body: JSON.stringify({}),
      });
      expect(approveResp.status).toBe(400);
      const error = await approveResp.json();
      expect(error.error.message).toMatch(/duplicate rows require resolution/);
    });
  });

  describe('Duplicate File Hash Rejection', () => {
    it('rejects upload of same file hash', async () => {
      const csv = `Date,Description,Debit,Credit,Reference
2025-01-20,Unique Transaction,50000,0,REF-010
`;
      const fileBuffer = Buffer.from(csv);
      const fileHash = createHash('sha256').update(fileBuffer).digest('hex');

      const formData = new FormData();
      formData.append('file', new Blob([fileBuffer]));
      formData.append('fileName', 'duplicate-hash.csv');
      formData.append('fileSize', fileBuffer.length.toString());
      formData.append('mimeType', 'text/csv');
      formData.append('source', 'CSV');
      formData.append('fileHash', fileHash);

      const resp1 = await fetch(`http://localhost:3000/api/v1/imports/statement/upload`, {
        method: 'POST',
        body: formData,
        headers: { 'x-test-user-id': userId, 'x-test-org-id': orgId },
      });
      expect(resp1.status).toBe(201);

      const resp2 = await fetch(`http://localhost:3000/api/v1/imports/statement/upload`, {
        method: 'POST',
        body: formData,
        headers: { 'x-test-user-id': userId, 'x-test-org-id': orgId },
      });
      expect(resp2.status).toBe(409);
      const error = await resp2.json();
      expect(error.error.message).toMatch(/already imported/);
    });
  });

  describe('Malformed Data Quarantine', () => {
    it('quarantines malformed dates with rawData preserved', async () => {
      const csv = `Date,Description,Debit,Credit,Reference
not-a-date,Malformed Date,100000,0,REF-020
2025-01-15,Valid Row,200000,0,REF-021
`;
      const { id: batchId } = await uploadStatementFile(csv, 'malformed-dates.csv');
      await createMapping(batchId);
      await validateImport(batchId);
      await detectDuplicates(batchId);

      const preview = await previewImport(batchId);
      const errorRow = preview.rows.find(r => r.rowNumber === 1);
      expect(errorRow.status).toBe('ERROR');
      expect(errorRow.errors.length).toBeGreaterThan(0);
      expect(errorRow.errors[0].field).toBe('date');
      expect(errorRow.errors[0].originalValue).toBe('not-a-date');

      const dbRow = await prisma.importRow.findFirst({
        where: { batchId, rowNumber: 1 },
        select: { rawData: true, status: true, errors: true },
      });
      expect(dbRow!.status).toBe('ERROR');
      expect(dbRow!.rawData).toEqual(['not-a-date', 'Malformed Date', '100000', '0', 'REF-020']);
      expect(dbRow!.errors.length).toBeGreaterThan(0);

      const validRow = preview.rows.find(r => r.rowNumber === 2);
      expect(validRow.status).toBe('VALID');
    });

    it('quarantines malformed amounts with rawData preserved', async () => {
      const csv = `Date,Description,Debit,Credit,Reference
2025-01-15,Bad Amount,not-a-number,0,REF-030
2025-01-16,Valid Amount,300000,0,REF-031
`;
      const { id: batchId } = await uploadStatementFile(csv, 'malformed-amounts.csv');
      await createMapping(batchId);
      await validateImport(batchId);
      await detectDuplicates(batchId);

      const preview = await previewImport(batchId);
      const errorRow = preview.rows.find(r => r.rowNumber === 1);
      expect(errorRow.status).toBe('ERROR');
      expect(errorRow.errors.some((e: any) => e.field === 'debit' || e.field === 'amount')).toBe(true);
      expect(errorRow.errors[0].originalValue).toBe('not-a-number');

      const dbRow = await prisma.importRow.findFirst({
        where: { batchId, rowNumber: 1 },
        select: { rawData: true, status: true },
      });
      expect(dbRow!.status).toBe('ERROR');
      expect(dbRow!.rawData).toEqual(['2025-01-15', 'Bad Amount', 'not-a-number', '0', 'REF-030']);
    });
  });

  describe('Preview Matches Committed Result', () => {
    it('preview rows match committed transactions exactly', async () => {
      const csv = `Date,Description,Debit,Credit,Reference
2025-01-15,Preview Match Test 1,100000,0,REF-040
2025-01-16,Preview Match Test 2,0,50000,REF-041
2025-01-17,Preview Match Test 3,75000,0,REF-042
`;
      const { id: batchId } = await uploadStatementFile(csv, 'preview-match.csv');
      await createMapping(batchId);
      await validateImport(batchId);
      await detectDuplicates(batchId);

      const preview = await previewImport(batchId);
      const validPreviewRows = preview.rows.filter((r: any) => r.status === 'VALID');

      await approveImport(batchId);
      const commitResult = await commitImport(batchId);

      expect(commitResult.results.length).toBe(validPreviewRows.length);

      for (let i = 0; i < validPreviewRows.length; i++) {
        const previewRow = validPreviewRows[i];
        const commitRow = commitResult.results[i];

        expect(commitRow.rowNumber).toBe(previewRow.rowNumber);
        expect(commitRow.reference).toBe(previewRow.reference);
        expect(commitRow.amount).toBe(previewRow.debit > 0 ? previewRow.debit : previewRow.credit);

        const transaction = await prisma.transaction.findUnique({
          where: { id: commitRow.transactionId },
          select: { reference: true, amount: true, description: true, date: true },
        });
        expect(transaction!.reference).toBe(previewRow.reference);
        expect(Number(transaction!.amount)).toBe(commitRow.amount);
        expect(transaction!.description).toBe(previewRow.description);
      }
    });
  });

  describe('Rollback', () => {
    it('restores pre-import state and is audited', async () => {
      const csv = `Date,Description,Debit,Credit,Reference
2025-01-20,Rollback Test 1,100000,0,REF-050
2025-01-21,Rollback Test 2,200000,0,REF-051
`;
      const { id: batchId } = await uploadStatementFile(csv, 'rollback-test.csv');
      await createMapping(batchId);
      await validateImport(batchId);
      await detectDuplicates(batchId);
      await approveImport(batchId);
      const commitResult = await commitImport(batchId);

      expect(commitResult.summary.imported).toBe(2);

      const importedTxIds = commitResult.results.map((r: any) => r.transactionId);
      for (const txId of importedTxIds) {
        const tx = await prisma.transaction.findUnique({ where: { id: txId } });
        expect(tx).not.toBeNull();
        expect(tx!.status).toBe(TransactionStatus.POSTED);

        const je = await prisma.journalEntry.findFirst({
          where: { transactionId: txId },
          include: { lines: true },
        });
        expect(je).not.toBeNull();
        expect(je!.lines.length).toBe(2);
      }

      const rollbackResult = await rollbackImport(batchId);
      expect(rollbackResult.deletedTransactions).toBe(2);
      expect(rollbackResult.deletedJournalEntries).toBe(2);
      expect(rollbackResult.deletedJournalLines).toBe(4);
      expect(rollbackResult.resetRows).toBe(2);

      for (const txId of importedTxIds) {
        const tx = await prisma.transaction.findUnique({ where: { id: txId } });
        expect(tx).toBeNull();

        const je = await prisma.journalEntry.findFirst({
          where: { transactionId: txId },
        });
        expect(je).toBeNull();
      }

      const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
      expect(batch!.status).toBe('ROLLED_BACK');
      expect(batch!.importedById).toBeNull();
      expect(batch!.importedAt).toBeNull();
      expect(batch!.validRows).toBe(2);

      const rows = await prisma.importRow.findMany({ where: { batchId, status: 'VALID' } });
      expect(rows.length).toBe(2);
      for (const row of rows) {
        expect(row.importedTransactionId).toBeNull();
      }

      const auditLog = await prisma.auditLog.findFirst({
        where: { entityId: batchId, action: 'IMPORT_ROLLED_BACK' },
        select: { changes: true },
      });
      expect(auditLog).not.toBeNull();
      expect(auditLog!.changes).toHaveProperty('status');
      expect(auditLog!.changes.status.from).toMatch(/COMPLETED|PARTIALLY_COMPLETED/);
      expect(auditLog!.changes.status.to).toBe('ROLLED_BACK');
      expect(auditLog!.changes).toHaveProperty('rollbackSummary');
    });
  });

  describe('Commit Creates Transaction + JournalEntry', () => {
    it('creates Transaction with verificationStatus = PENDING_VERIFICATION per valid row', async () => {
      const csv = `Date,Description,Debit,Credit,Reference
2025-01-25,Commit Test Debit,150000,0,REF-060
2025-01-26,Commit Test Credit,0,75000,REF-061
`;
      const { id: batchId } = await uploadStatementFile(csv, 'commit-test.csv');
      await createMapping(batchId);
      await validateImport(batchId);
      await detectDuplicates(batchId);
      await approveImport(batchId);
      const commitResult = await commitImport(batchId);

      expect(commitResult.results.length).toBe(2);

      for (const result of commitResult.results) {
        const transaction = await prisma.transaction.findUnique({
          where: { id: result.transactionId },
          select: {
            id: true,
            reference: true,
            amount: true,
            status: true,
            verificationStatus: true,
            source: true,
            description: true,
            date: true,
          },
        });

        expect(transaction).not.toBeNull();
        expect(transaction!.status).toBe(TransactionStatus.POSTED);
        expect(transaction!.verificationStatus).toBe(VerificationStatus.PENDING_VERIFICATION);
        expect(transaction!.source).toBe('IMPORT');
        expect(transaction!.reference).toBe(result.reference);
        expect(Number(transaction!.amount)).toBe(result.amount);

        const journalEntry = await prisma.journalEntry.findFirst({
          where: { transactionId: transaction!.id },
          include: { lines: { include: { account: true } } },
        });

        expect(journalEntry).not.toBeNull();
        expect(journalEntry!.type).toBe(JournalEntryType.STANDARD);
        expect(journalEntry!.status).toBe(JournalEntryStatus.POSTED);
        expect(journalEntry!.source).toBe(JournalSource.IMPORT);
        expect(journalEntry!.lines.length).toBe(2);

        const totalDebit = journalEntry!.lines.reduce((sum, l) => sum + Number(l.debit), 0);
        const totalCredit = journalEntry!.lines.reduce((sum, l) => sum + Number(l.credit), 0);
        expect(totalDebit).toBe(totalCredit);
        expect(totalDebit).toBe(result.amount);

        const primaryLine = journalEntry!.lines.find(l => l.accountId === bankAccountId);
        const counterpartyLine = journalEntry!.lines.find(l => l.accountId === liabilityAccountId);
        expect(primaryLine).toBeDefined();
        expect(counterpartyLine).toBeDefined();

        const importRow = await prisma.importRow.findUnique({
          where: { id: result.rowNumber }, // Note: using rowNumber as ID won't work, need batchId + rowNumber
        });
        const row = await prisma.importRow.findFirst({
          where: { batchId, rowNumber: result.rowNumber },
          select: { status: true, importedTransactionId: true },
        });
        expect(row!.status).toBe('IMPORTED');
        expect(row!.importedTransactionId).toBe(transaction!.id);
      }
    });

    it('sets importedById, importedAt on batch', async () => {
      const csv = `Date,Description,Debit,Credit,Reference
2025-01-27,Batch Meta Test,100000,0,REF-070
`;
      const { id: batchId } = await uploadStatementFile(csv, 'batch-meta.csv');
      await createMapping(batchId);
      await validateImport(batchId);
      await detectDuplicates(batchId);
      await approveImport(batchId);
      await commitImport(batchId);

      const batch = await prisma.importBatch.findUnique({
        where: { id: batchId },
        select: { importedById: true, importedAt: true, status: true, validRows: true },
      });
      expect(batch!.importedById).toBe(userId);
      expect(batch!.importedAt).not.toBeNull();
      expect(batch!.status).toBe('COMPLETED');
      expect(batch!.validRows).toBe(1);
    });
  });
});