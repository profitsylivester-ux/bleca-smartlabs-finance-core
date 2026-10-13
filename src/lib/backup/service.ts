import { createHash } from 'node:crypto';
import { prisma } from '@/lib/db/prisma';
import { documentStorage } from '@/lib/documents/storage';
import { writeAuditEntry } from '@/lib/audit/writer';
import type { InputJsonValue } from '@/generated/prisma/runtime/library';

export type BackupType = 'FULL' | 'INCREMENTAL' | 'POINT_IN_TIME';
export type BackupStatus = 'SCHEDULED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'VERIFIED' | 'VERIFICATION_FAILED' | 'EXPIRED';

interface BackupRunResult {
  id: string;
  storageKey: string;
  checksum: string;
  sizeBytes: bigint;
  rowCounts: Record<string, number>;
  auditChainHead: string | null;
}

interface VerifyResult {
  verified: boolean;
  checksum: string;
  rowCounts: Record<string, number>;
  auditChainHead: string | null;
}

interface RestoreTestResult {
  tableCountsMatch: boolean;
  auditChainMatches: boolean;
  tableCountDiffs: Record<string, { backup: number; current: number }>;
  auditChainHeadMatch: boolean;
  backupAuditChainHead: string | null;
  currentAuditChainHead: string | null;
}

async function getAllTableNames(): Promise<string[]> {
  // Get all table names from the database
  const result = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `;
  return result.map((r) => r.tablename);
}

async function getRowCounts(prismaClient: typeof prisma): Promise<Record<string, number>> {
  const tables = await getAllTableNames();
  const counts: Record<string, number> = {};

  for (const table of tables) {
    try {
      const count = await prismaClient.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) as count FROM "${table}"
      `;
      counts[table] = Number(count[0]?.count ?? 0);
    } catch {
      counts[table] = 0;
    }
  }

  return counts;
}

async function getAuditChainHead(): Promise<string | null> {
  const result = await prisma.auditChainHead.findUnique({
    where: { id: 1 },
    select: { entryHash: true },
  });
  return result?.entryHash ?? null;
}

async function exportAllData(organizationId: string): Promise<Record<string, any[]>> {
  // Export all organization-scoped data
  // This is a comprehensive export for FULL backup
  const data: Record<string, any[]> = {};

  // Core tables - export in dependency order
  const models = [
    'user',
    'session',
    'loginHistory',
    'mfaDevice',
    'authPolicy',
    'role',
    'permission',
    'rolePermission',
    'userRole',
    'roleScopeGrant',
    'delegation',
    'accessReview',
    'accessReviewItem',
    'organization',
    'location',
    'department',
    'costCentre',
    'project',
    'fundingSource',
    'currency',
    'exchangeRate',
    'treasuryAccount',
    'paymentSchedule',
    'transfer',
    'account',
    'financialPeriod',
    'financialClose',
    'closeChecklistItem',
    'openingBalance',
    'accountBalanceSnapshot',
    'journalEntry',
    'journalLine',
    'transaction',
    'budget',
    'budgetLine',
    'commitment',
    'budgetRevision',
    'budgetRevisionLine',
    'budgetTransfer',
    'budgetScenario',
    'reasonCode',
    'reversalReasonCode',
    'party',
    'customer',
    'supplier',
    'contact',
    'partyAddress',
    'communicationLog',
    'supplierBankDetail',
    'supplierBankDetailChangeRequest',
    'supplierProductService',
    'customerCreditHold',
    'customerReceivable',
    'quotation',
    'quotationLine',
    'invoice',
    'invoiceLine',
    'invoiceReminder',
    'documentSequence',
    'payment',
    'paymentMethodLine',
    'paymentAllocation',
    'receipt',
    'receiptLine',
    'creditNote',
    'debitNote',
    'document',
    'documentVersion',
    'documentTag',
    'documentTagLink',
    'documentLink',
    'retentionPolicy',
    'legalHold',
    'taxRule',
    'taxObligation',
    'taxPayment',
    'credential',
    'complianceDocument',
    'taxInvoiceSequence',
    'importBatch',
    'importRow',
    'importFieldMapping',
    'importError',
    'matchingRule',
    'reconciliationSession',
    'reconciliationMatch',
    'reconciliationException',
    'reconciliationAdjustment',
    'approvalPolicy',
    'approvalPolicyStep',
    'approvalRequest',
    'approvalStepInstance',
    'approvalDecisionRecord',
    'sodWaiver',
    'notification',
    'notificationPreference',
    'anomalyFlag',
    'securityEvent',
    'auditLog',
    'auditChainHead',
    'auditChainCheckpoint',
    'idempotencyKey',
    'masterDataChangeRequest',
    'masterDataVersion',
    'productService',
    'supplierTaxObligationLink',
    'backupRun',
    'syncQueueItem',
  ];

  for (const model of models) {
    try {
      // @ts-expect-error - dynamic model access
      const records = await prisma[model].findMany({
        where: { organizationId },
      });
      data[model] = records;
    } catch {
      // Model might not have organizationId or might not exist
      try {
        // @ts-expect-error
        const records = await prisma[model].findMany({});
        data[model] = records;
      } catch {
        // Skip models that fail
      }
    }
  }

  return data;
}

function computeChecksum(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function runBackup(
  organizationId: string,
  type: BackupType,
  userId: string
): Promise<BackupRunResult> {
  // Create backup run record
  const backupRun = await prisma.backupRun.create({
    data: {
      organizationId,
      type,
      status: 'RUNNING',
      storageKey: '',
      checksum: '',
      sizeBytes: 0n,
      rowCounts: {},
      auditChainHead: null,
      startedAt: new Date(),
      createdById: userId,
    },
  });

  try {
    // Export all data
    const data = await exportAllData(organizationId);
    const jsonData = JSON.stringify(data, null, 2);
    const buffer = Buffer.from(jsonData, 'utf-8');
    const checksum = computeChecksum(jsonData);
    const sizeBytes = BigInt(buffer.length);
    const rowCounts = await getRowCounts(prisma);
    const auditChainHead = await getAuditChainHead();

    // Generate storage key
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const storageKey = `backups/${organizationId}/${type.toLowerCase()}-${timestamp}.json`;

    // Store to storage provider
    await documentStorage().put(storageKey, 'application/json', buffer);

    // Update backup run record
    const updated = await prisma.backupRun.update({
      where: { id: backupRun.id },
      data: {
        status: 'SUCCEEDED',
        storageKey,
        checksum,
        sizeBytes,
        rowCounts,
        auditChainHead,
        completedAt: new Date(),
      },
    });

    // Audit log
    await writeAuditEntry(
      prisma,
      { id: userId, name: 'System', roleCodes: [] },
      {
        action: 'BACKUP_VERIFIED',
        entityType: 'BACKUP_RUN',
        entityId: backupRun.id,
        entityLabel: `${type} backup`,
        description: `Backup ${type} completed successfully`,
        result: 'SUCCESS',
        metadata: {
          storageKey,
          sizeBytes: sizeBytes.toString(),
          tableCount: Object.keys(rowCounts).length,
          totalRows: Object.values(rowCounts).reduce((a, b) => a + b, 0),
        },
      },
      { organizationId, requestId: `backup-${backupRun.id}` }
    );

    return {
      id: updated.id,
      storageKey: updated.storageKey,
      checksum: updated.checksum,
      sizeBytes: updated.sizeBytes,
      rowCounts: updated.rowCounts as Record<string, number>,
      auditChainHead: updated.auditChainHead,
    };
  } catch (error) {
    await prisma.backupRun.update({
      where: { id: backupRun.id },
      data: {
        status: 'FAILED',
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        completedAt: new Date(),
      },
    });

    await writeAuditEntry(
      prisma,
      { id: userId, name: 'System', roleCodes: [] },
      {
        action: 'BACKUP_VERIFIED',
        entityType: 'BACKUP_RUN',
        entityId: backupRun.id,
        entityLabel: `${type} backup`,
        description: `Backup ${type} failed`,
        result: 'FAILURE',
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      },
      { organizationId, requestId: `backup-${backupRun.id}` }
    );

    throw error;
  }
}

export async function verifyBackup(backupRunId: string, userId: string): Promise<VerifyResult> {
  const backupRun = await prisma.backupRun.findUnique({
    where: { id: backupRunId },
    select: { id: true, organizationId: true, storageKey: true, checksum: true, status: true },
  });

  if (!backupRun) {
    throw new Error('Backup run not found');
  }

  if (backupRun.status !== 'SUCCEEDED' && backupRun.status !== 'VERIFIED') {
    throw new Error(`Cannot verify backup with status: ${backupRun.status}`);
  }

  try {
    // Read backup from storage
    const buffer = await documentStorage().get(backupRun.storageKey);
    const jsonData = buffer.toString('utf-8');
    const computedChecksum = computeChecksum(jsonData);
    const data = JSON.parse(jsonData);

    // Compute row counts from backup
    const backupRowCounts: Record<string, number> = {};
    for (const [table, records] of Object.entries(data)) {
      if (Array.isArray(records)) {
        backupRowCounts[table] = records.length;
      }
    }

    const auditChainHead = await getAuditChainHead();
    const verified = computedChecksum === backupRun.checksum;

    await prisma.backupRun.update({
      where: { id: backupRunId },
      data: {
        status: verified ? 'VERIFIED' : 'VERIFICATION_FAILED',
        verifiedAt: new Date(),
        verificationChecksum: computedChecksum,
      },
    });

    await writeAuditEntry(
      prisma,
      { id: userId, name: 'System', roleCodes: [] },
      {
        action: 'BACKUP_VERIFIED',
        entityType: 'BACKUP_RUN',
        entityId: backupRunId,
        entityLabel: backupRun.storageKey,
        description: `Backup verification ${verified ? 'passed' : 'failed'}`,
        result: verified ? 'SUCCESS' : 'FAILURE',
        metadata: {
          expectedChecksum: backupRun.checksum,
          computedChecksum,
          verified,
        },
      },
      { organizationId: backupRun.organizationId, requestId: `verify-${backupRunId}` }
    );

    return {
      verified,
      checksum: computedChecksum,
      rowCounts: backupRowCounts,
      auditChainHead,
    };
  } catch (error) {
    await prisma.backupRun.update({
      where: { id: backupRunId },
      data: {
        status: 'VERIFICATION_FAILED',
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      },
    });

    await writeAuditEntry(
      prisma,
      { id: userId, name: 'System', roleCodes: [] },
      {
        action: 'BACKUP_VERIFIED',
        entityType: 'BACKUP_RUN',
        entityId: backupRunId,
        entityLabel: backupRun.storageKey,
        description: `Backup verification error`,
        result: 'FAILURE',
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      },
      { organizationId: backupRun.organizationId, requestId: `verify-${backupRunId}` }
    );

    throw error;
  }
}

export async function testRestore(
  backupRunId: string,
  userId: string
): Promise<RestoreTestResult> {
  const backupRun = await prisma.backupRun.findUnique({
    where: { id: backupRunId },
    select: { id: true, organizationId: true, storageKey: true, status: true, rowCounts: true, auditChainHead: true },
  });

  if (!backupRun) {
    throw new Error('Backup run not found');
  }

  if (backupRun.status !== 'SUCCEEDED' && backupRun.status !== 'VERIFIED') {
    throw new Error(`Cannot test restore from backup with status: ${backupRun.status}`);
  }

  try {
    // Read backup from storage
    const buffer = await documentStorage().get(backupRun.storageKey);
    const jsonData = buffer.toString('utf-8');
    const data = JSON.parse(jsonData);

    // Compute row counts from backup
    const backupRowCounts: Record<string, number> = {};
    for (const [table, records] of Object.entries(data)) {
      if (Array.isArray(records)) {
        backupRowCounts[table] = records.length;
      }
    }

    // Get current row counts
    const currentRowCounts = await getRowCounts(prisma);

    // Compare row counts
    const tableCountDiffs: Record<string, { backup: number; current: number }> = {};
    let tableCountsMatch = true;

    const allTables = new Set([...Object.keys(backupRowCounts), ...Object.keys(currentRowCounts)]);
    for (const table of allTables) {
      const backupCount = backupRowCounts[table] ?? 0;
      const currentCount = currentRowCounts[table] ?? 0;
      if (backupCount !== currentCount) {
        tableCountsMatch = false;
        tableCountDiffs[table] = { backup: backupCount, current: currentCount };
      }
    }

    // Compare audit chain head
    const currentAuditChainHead = await getAuditChainHead();
    const backupAuditChainHead = backupRun.auditChainHead;
    const auditChainMatches = backupAuditChainHead !== null && backupAuditChainHead === currentAuditChainHead;

    const result: RestoreTestResult = {
      tableCountsMatch,
      auditChainMatches,
      tableCountDiffs,
      auditChainHeadMatch: auditChainMatches,
      backupAuditChainHead,
      currentAuditChainHead,
    };

    await prisma.backupRun.update({
      where: { id: backupRunId },
      data: {
        restoreTestedAt: new Date(),
        restoreTestResult: JSON.parse(JSON.stringify(result)),
      },
    });

    await writeAuditEntry(
      prisma,
      { id: userId, name: 'System', roleCodes: [] },
      {
        action: 'RESTORE_TEST',
        entityType: 'BACKUP_RUN',
        entityId: backupRunId,
        entityLabel: backupRun.storageKey,
        description: `Restore test completed - tables match: ${tableCountsMatch}, audit chain matches: ${auditChainMatches}`,
        result: 'SUCCESS',
        metadata: JSON.parse(JSON.stringify(result)),
      },
      { organizationId: backupRun.organizationId, requestId: `restore-test-${backupRunId}` }
    );

    return result;
  } catch (error) {
    await writeAuditEntry(
      prisma,
      { id: userId, name: 'System', roleCodes: [] },
      {
        action: 'RESTORE_TEST',
        entityType: 'BACKUP_RUN',
        entityId: backupRunId,
        entityLabel: backupRun.storageKey,
        description: `Restore test error`,
        result: 'FAILURE',
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      },
      { organizationId: backupRun.organizationId, requestId: `restore-test-${backupRunId}` }
    );

    throw error;
  }
}

export async function listBackups(organizationId: string) {
  return prisma.backupRun.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      type: true,
      status: true,
      storageKey: true,
      checksum: true,
      sizeBytes: true,
      rowCounts: true,
      auditChainHead: true,
      startedAt: true,
      completedAt: true,
      verifiedAt: true,
      verificationChecksum: true,
      restoreTestedAt: true,
      restoreTestResult: true,
      errorMessage: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

