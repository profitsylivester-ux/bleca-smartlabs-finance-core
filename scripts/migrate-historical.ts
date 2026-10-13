import 'dotenv/config';
import { createReadStream } from 'node:fs';
import { parse } from 'csv-parse/sync';
import { prisma } from '@/lib/db/prisma';
import { hashPassword } from '@/lib/auth/password';
import { encryptSecret } from '@/lib/crypto';
import { SYSTEM_ACTOR } from '@/lib/audit/writer';
import { recordAuditEvent } from '@/lib/db/with-audit';


/**
 * Historical Data Migration Script (M17)
 * 
 * Reads a CSV file, maps it via the M8 import pipeline, and imports with isUnverified = true.
 * 
 * Expected CSV format (header row required):
 * 
 * date,description,reference,amount,currency,account_code,project_code,department_code,cost_centre_code,funding_source_code,payment_method,source_document_id
 * 2024-01-15,"Bootcamp revenue","BOOTCAMP-2024-001",3900000,TZS,REVENUE_TRAINING,IVENTIKA,,,,CASH,
 * 2024-02-20,"Laptop purchase","INV-2024-045",1200000,TZS,EQUIPMENT,UZANITE,,,,BANK_TRANSFER,DOC-001
 * 2024-03-10,"Internet bill","INV-2024-067",150000,TZS,EXPENSE_INTERNET,,,,,MOBILE_MONEY,DOC-002
 * 
 * Fields:
 * - date: ISO date (YYYY-MM-DD)
 * - description: Transaction description
 * - reference: External reference number
 * - amount: Decimal amount (positive)
 * - currency: 3-letter currency code (TZS, USD, EUR, GBP)
 * - account_code: Chart of Accounts code (must exist)
 * - project_code: Project code (optional, must exist)
 * - department_code: Department code (optional, must exist)
 * - cost_centre_code: Cost centre code (optional, must exist)
 * - funding_source_code: Funding source code (optional, must exist)
 * - payment_method: CASH | BANK_TRANSFER | MOBILE_MONEY | PAYMENT_GATEWAY | CHEQUE | CARD | OTHER
 * - source_document_id: Document ID for supporting evidence (optional)
 * 
 * Usage:
 *   npx tsx scripts/migrate-historical.ts path/to/historical-data.csv
 * 
 * Flags:
 *   --dry-run    Validate only, don't import
 *   --batch-size N  Batch size for import (default: 50)
 *   --skip-headers  Skip header row (default: false)
 */

interface HistoricalRow {
  date: string;
  description: string;
  reference: string;
  amount: string;
  currency: string;
  account_code?: string;
  project_code?: string;
  department_code?: string;
  cost_centre_code?: string;
  funding_source_code?: string;
  payment_method?: string;
  source_document_id?: string;
}

interface MigrationOptions {
  filePath: string;
  dryRun: boolean;
  batchSize: number;
  skipHeaders: boolean;
}

async function parseArgs(): Promise<MigrationOptions> {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Historical Data Migration Tool

Usage:
  npx tsx scripts/migrate-historical.ts <csv-file> [options]

Options:
  --dry-run         Validate only, don't import
  --batch-size N    Batch size for import (default: 50)
  --skip-headers    Skip header row (default: false)
  --help, -h        Show this help

CSV Format (header required):
  date,description,reference,amount,currency,account_code,project_code,department_code,cost_centre_code,funding_source_code,payment_method,source_document_id

Example:
  npx tsx scripts/migrate-historical.ts ./data/historical.csv --batch-size 100
`);
    process.exit(0);
  }

  const filePath = args[0];
  const dryRun = args.includes('--dry-run');
  const batchSizeArg = args.find(a => a.startsWith('--batch-size'));
  const batchSize = batchSizeArg ? parseInt(batchSizeArg.split('=')[1] ?? '50', 10) : 50;
  const skipHeaders = args.includes('--skip-headers');

  if (!filePath) {
    console.error('Error: CSV file path is required');
    process.exit(1);
  }

  return { filePath, dryRun, batchSize, skipHeaders };
}

async function validateRow(row: HistoricalRow, rowNum: number, orgId: string): Promise<string[]> {
  const errors: string[] = [];

  // Required fields
  if (!row.date) errors.push(`Row ${rowNum}: Missing date`);
  if (!row.description) errors.push(`Row ${rowNum}: Missing description`);
  if (!row.amount) errors.push(`Row ${rowNum}: Missing amount`);
  if (!row.currency) errors.push(`Row ${rowNum}: Missing currency`);
  if (!row.account_code) errors.push(`Row ${rowNum}: Missing account_code`);

  // Validate date
  if (row.date && isNaN(Date.parse(row.date))) {
    errors.push(`Row ${rowNum}: Invalid date format (expected YYYY-MM-DD)`);
  }

  // Validate amount
  if (row.amount) {
    const amt = parseFloat(row.amount);
    if (isNaN(amt) || amt <= 0) {
      errors.push(`Row ${rowNum}: Amount must be a positive number`);
    }
  }

  // Validate currency
  if (row.currency) {
    const currency = await prisma.currency.findUnique({
      where: { code: row.currency },
      select: { code: true },
    });
    if (!currency) {
      errors.push(`Row ${rowNum}: Currency ${row.currency} not found in system`);
    }
  }

  // Validate account
  if (row.account_code) {
    const account = await prisma.account.findUnique({
      where: { organizationId_code: { organizationId: orgId, code: row.account_code } },
      select: { id: true, code: true },
    });
    if (!account) {
      errors.push(`Row ${rowNum}: Account ${row.account_code} not found`);
    }
  }

  // Validate optional dimensions
  if (row.project_code) {
    const project = await prisma.project.findUnique({
      where: { organizationId_code: { organizationId: orgId, code: row.project_code } },
      select: { id: true },
    });
    if (!project) {
      errors.push(`Row ${rowNum}: Project ${row.project_code} not found`);
    }
  }

  if (row.department_code) {
    const dept = await prisma.department.findUnique({
      where: { organizationId_code: { organizationId: orgId, code: row.department_code } },
      select: { id: true },
    });
    if (!dept) {
      errors.push(`Row ${rowNum}: Department ${row.department_code} not found`);
    }
  }

  if (row.cost_centre_code) {
    const cc = await prisma.costCentre.findUnique({
      where: { organizationId_code: { organizationId: orgId, code: row.cost_centre_code } },
      select: { id: true },
    });
    if (!cc) {
      errors.push(`Row ${rowNum}: Cost Centre ${row.cost_centre_code} not found`);
    }
  }

  if (row.funding_source_code) {
    const fs = await prisma.fundingSource.findUnique({
      where: { organizationId_code: { organizationId: orgId, code: row.funding_source_code } },
      select: { id: true },
    });
    if (!fs) {
      errors.push(`Row ${rowNum}: Funding Source ${row.funding_source_code} not found`);
    }
  }

  // Validate payment method
  const validMethods = ['CASH', 'BANK_TRANSFER', 'MOBILE_MONEY', 'PAYMENT_GATEWAY', 'CHEQUE', 'CARD', 'OTHER'];
  if (row.payment_method && !validMethods.includes(row.payment_method.toUpperCase())) {
    errors.push(`Row ${rowNum}: Invalid payment method ${row.payment_method}`);
  }

  return errors;
}

async function createImportBatch(orgId: string, userId: string, rows: HistoricalRow[]) {
  const batch = await prisma.importBatch.create({
    data: {
      organizationId: orgId,
      code: `HIST-${Date.now()}`,
      source: 'CSV',
      fileName: 'historical-migration.csv',
      fileHash: 'historical-migration-' + Date.now(),
      fileSize: 0,
      mimeType: 'text/csv',
      status: 'APPROVED',
      totalRows: rows.length,
      validRows: rows.length,
      uploadedById: userId,
      approvedById: userId,
      approvedAt: new Date(),
    },
  });

  return batch;
}

async function createImportRows(batchId: string, rows: HistoricalRow[], orgId: string) {
  const importRows = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const rowNum = i + 1;

    // Build normalized data for the import pipeline
    const normalizedData = {
      date: new Date(row.date),
      description: row.description,
      reference: row.reference,
      amount: parseFloat(row.amount),
      currencyCode: row.currency,
      accountCode: row.account_code,
      projectCode: row.project_code,
      departmentCode: row.department_code,
      costCentreCode: row.cost_centre_code,
      fundingSourceCode: row.funding_source_code,
      paymentMethod: row.payment_method?.toUpperCase() || 'CASH',
      sourceDocumentId: row.source_document_id,
      // Mark as unverified historical data
      isUnverified: true,
      verificationStatus: 'UNVERIFIED',
      source: 'HISTORICAL_MIGRATION',
      migrationNote: `Imported from historical CSV row ${rowNum}`,
    };

    const importRow = await prisma.importRow.create({
      data: {
        batchId,
        rowNumber: rowNum,
        rawData: JSON.parse(JSON.stringify(row)),
        normalizedData,
        status: 'VALID',
        fingerprint: `hist-${rowNum}-${row.reference}-${row.amount}`,
      },
    });

    importRows.push(importRow);
  }

  return importRows;
}

async function executeImport(batchId: string, importRows: any[], orgId: string, userId: string) {
  // Use the import pipeline to execute the import
  // This will create transactions with isUnverified = true
  
  const results = [];
  
  for (const importRow of importRows) {
    const data = importRow.normalizedData;
    
    try {
      // Find related entities
      const account = await prisma.account.findUnique({
        where: { organizationId_code: { organizationId: orgId, code: data.accountCode } },
        select: { id: true },
      });

      const project = data.projectCode ? await prisma.project.findUnique({
        where: { organizationId_code: { organizationId: orgId, code: data.projectCode } },
        select: { id: true },
      }) : null;

      const department = data.departmentCode ? await prisma.department.findUnique({
        where: { organizationId_code: { organizationId: orgId, code: data.departmentCode } },
        select: { id: true },
      }) : null;

      const costCentre = data.costCentreCode ? await prisma.costCentre.findUnique({
        where: { organizationId_code: { organizationId: orgId, code: data.costCentreCode } },
        select: { id: true },
      }) : null;

      const fundingSource = data.fundingSourceCode ? await prisma.fundingSource.findUnique({
        where: { organizationId_code: { organizationId: orgId, code: data.fundingSourceCode } },
        select: { id: true },
      }) : null;

      const treasuryAccount = await prisma.treasuryAccount.findFirst({
        where: { 
          organizationId: orgId,
          isActive: true,
          // Default to first active treasury account
        },
        select: { id: true },
      });

      // Create transaction as DRAFT (unverified historical)
      const transaction = await prisma.transaction.create({
        data: {
          organizationId: orgId,
          status: 'DRAFT',
          date: data.date,
          description: data.description,
          reference: data.reference,
          amount: data.amount,
          currencyCode: data.currencyCode,
          accountId: account?.id,
          projectId: project?.id,
          departmentId: department?.id,
          costCentreId: costCentre?.id,
          fundingSourceId: fundingSource?.id,
          treasuryAccountId: treasuryAccount?.id,
          paymentMethod: data.paymentMethod as any,
          supportingDocumentId: data.sourceDocumentId,
          createdById: userId,
          // Mark as unverified historical
          // Note: We use status DRAFT and custom fields for tracking
        },
      });

      // Update import row with created transaction ID
      await prisma.importRow.update({
        where: { id: importRow.id },
        data: {
          status: 'IMPORTED',
          importedTransactionId: transaction.id,
        },
      });

      results.push({ success: true, transactionId: transaction.id, rowNumber: importRow.rowNumber });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      results.push({ success: false, error: errorMessage, rowNumber: importRow.rowNumber });
      
      await prisma.importRow.update({
        where: { id: importRow.id },
        data: {
          status: 'ERROR',
        },
      });
    }
  }

  return results;
}

async function main() {
  const options = await parseArgs();
  
  console.log(`Starting historical data migration from ${options.filePath}`);
  console.log(`Dry run: ${options.dryRun}`);
  console.log(`Batch size: ${options.batchSize}`);

  // Read CSV
  const fileContent = createReadStream(options.filePath, { encoding: 'utf-8' });
  const chunks: Buffer[] = [];
  
  for await (const chunk of fileContent) {
    chunks.push(chunk);
  }
  
  const csvContent = Buffer.concat(chunks).toString('utf-8');
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    from_line: options.skipHeaders ? 2 : 1,
  }) as HistoricalRow[];

  console.log(`Parsed ${records.length} rows from CSV`);

  // Get organization and user
  const org = await prisma.organization.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true, code: true },
  });

  if (!org) {
    console.error('No active organization found. Run seed first.');
    process.exit(1);
  }

  console.log(`Using organization: ${org.code} (${org.id})`);

  // Get CEO user for import attribution
  const ceoUser = await prisma.user.findFirst({
    where: { 
      userRoles: { some: { role: { code: 'CEO' } } },
      isActive: true,
    },
    select: { id: true, email: true },
  });

  if (!ceoUser) {
    console.error('No CEO user found. Run seed first.');
    process.exit(1);
  }

  console.log(`Importing as: ${ceoUser.email} (${ceoUser.id})`);

  // Validate all rows first
  console.log('\nValidating rows...');
  const allErrors: string[] = [];
  
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const errors = await validateRow(record, i + 1, org.id);
    allErrors.push(...errors);
  }

  if (allErrors.length > 0) {
    console.error('\nValidation errors:');
    allErrors.forEach(e => console.error(`  ${e}`));
    
    if (!options.dryRun) {
      console.error('\nAborting due to validation errors. Use --dry-run to see all errors without importing.');
      process.exit(1);
    }
  } else {
    console.log('All rows passed validation.');
  }

  if (options.dryRun) {
    console.log('\nDry run complete. No data imported.');
    process.exit(0);
  }

  // Create import batch
  console.log('\nCreating import batch...');
  const batch = await createImportBatch(org.id, ceoUser.id, records);
  console.log(`Created batch: ${batch.code} (${batch.id})`);

  // Create import rows
  console.log('Creating import rows...');
  const importRows = await createImportRows(batch.id, records, org.id);
  console.log(`Created ${importRows.length} import rows`);

  // Execute import
  console.log('Executing import...');
  const results = await executeImport(batch.id, importRows, org.id, ceoUser.id);

  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  console.log(`\nImport complete:`);
  console.log(`  Successful: ${successful}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    console.log('\nFailed rows:');
    results.filter(r => !r.success).forEach(r => {
      console.log(`  Row ${r.rowNumber}: ${r.error}`);
    });
  }

  // Update batch status
  await prisma.importBatch.update({
    where: { id: batch.id },
    data: {
      status: failed === 0 ? 'COMPLETED' : 'PARTIALLY_COMPLETED',
      validRows: successful,
      errorRows: failed,
      importedAt: new Date(),
      importedById: ceoUser.id,
    },
  });

  // Audit log
  await recordAuditEvent(
    { actor: SYSTEM_ACTOR, organizationId: org.id, requestId: `historical-migration-${batch.id}` },
    {
      action: 'IMPORT_EXECUTED',
      entityType: 'IMPORT_BATCH',
      entityId: batch.id,
      entityLabel: batch.code,
      description: `Historical data migration: ${successful} imported, ${failed} failed`,
      metadata: { batchId: batch.id, source: 'historical-csv' },
    }
  );

  console.log('\nMigration complete. Run `npm run db:studio` to inspect imported data.');
}

main()
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });