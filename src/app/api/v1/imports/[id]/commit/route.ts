import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { Decimal } from '@prisma/client/runtime/library';
import { prisma, TransactionStatus, VerificationStatus, JournalEntryType, JournalEntryStatus, JournalSource } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { ValidationError, NotFoundError } from '@/lib/kernel/errors';

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

interface CommitResult {
  transactionId: string;
  journalEntryId: string;
  rowNumber: number;
  reference: string | null;
  amount: number;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'STATEMENT_IMPORT', action: 'POST' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const key = request.headers.get('idempotency-key');
    if (!key) {
      return apiError(new ValidationError('An Idempotency-Key header is required on this endpoint.'), reqId);
    }

    const { id } = await params;

    const batch = await prisma.importBatch.findFirst({
      where: { id, organizationId: ctx.actor.organizationId },
      select: {
        id: true,
        code: true,
        status: true,
        source: true,
        validRows: true,
        organizationId: true,
        uploadedById: true,
      },
    });

    if (!batch) {
      return apiError(new NotFoundError('Import batch', id), reqId);
    }

    if (batch.status !== 'APPROVED') {
      return apiError(new ValidationError(`Cannot commit in ${batch.status} status. Approve first.`), reqId);
    }

    if (batch.validRows === 0) {
      return apiError(new ValidationError('No valid rows to commit'), reqId);
    }

    const validRows = await prisma.importRow.findMany({
      where: { batchId: id, status: 'VALID' },
      orderBy: { rowNumber: 'asc' },
      select: {
        id: true,
        rowNumber: true,
        normalizedData: true,
        fingerprint: true,
      },
    });

    if (validRows.length === 0) {
      return apiError(new ValidationError('No valid rows found to commit'), reqId);
    }

    const orgId = ctx.actor.organizationId!;
    const importDate = new Date();

    const defaultLiabilityAccount = await prisma.account.findFirst({
      where: { organizationId: orgId, type: 'LIABILITY', isPostable: true },
      orderBy: { code: 'asc' },
      select: { id: true, normalBalance: true },
    });

    if (!defaultLiabilityAccount) {
      return apiError(new ValidationError('No postable liability account found for counterparty'), reqId);
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/imports/${id}/commit`,
      actorId: ctx.actor.userId,
      body: {},
      handler: async () =>
        withAudit(
          {
            organizationId: orgId,
            actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
            ipAddress: net.ipAddress,
            userAgent: net.userAgent,
            requestId: reqId,
            sessionId: ctx.actor.sessionId,
          },
          async (tx) => {
            await tx.importBatch.update({
              where: { id },
              data: { status: 'IMPORTING' },
            });

            const results: CommitResult[] = [];
            let successCount = 0;
            let failCount = 0;

            for (const row of validRows) {
              const normalized = row.normalizedData as Record<string, unknown> | null;
              if (!normalized) {
                failCount++;
                await tx.importRow.update({
                  where: { id: row.id },
                  data: { status: 'ERROR' },
                });
                await tx.importError.create({
                  data: {
                    batchId: id,
                    rowId: row.id,
                    rowNumber: row.rowNumber,
                    type: 'SYSTEM',
                    field: 'normalizedData',
                    originalValue: null,
                    message: 'Missing normalized data',
                    severity: 'ERROR',
                  },
                });
                continue;
              }

              const dateStr = normalized.date as string | null;
              const description = (normalized.description as string) ?? `Imported from ${batch.code}`;
              const reference = (normalized.reference as string) ?? `IMP-${batch.code}-${String(row.rowNumber).padStart(4, '0')}`;
              const debit = Number(normalized.debit ?? 0);
              const credit = Number(normalized.credit ?? 0);
              const amount = debit > 0 ? debit : credit;
              const currencyCode = 'TZS';

              if (amount <= 0) {
                failCount++;
                await tx.importRow.update({
                  where: { id: row.id },
                  data: { status: 'ERROR' },
                });
                await tx.importError.create({
                  data: {
                    batchId: id,
                    rowId: row.id,
                    rowNumber: row.rowNumber,
                    type: 'VALIDATION',
                    field: 'amount',
                    originalValue: { debit, credit },
                    message: 'Invalid amount: both debit and credit are zero',
                    severity: 'ERROR',
                  },
                });
                continue;
              }

              const date = dateStr ? new Date(dateStr) : new Date();
              const isDebit = debit > 0;

              let treasuryAccountId: string | null = null;
              let projectId: string | null = null;
              let departmentId: string | null = null;
              let costCentreId: string | null = null;
              let fundingSourceId: string | null = null;

              try {
                const transaction = await tx.transaction.create({
                  data: {
                    organizationId: orgId,
                    status: TransactionStatus.POSTED,
                    date,
                    description,
                    reference,
                    amount: new Decimal(amount),
                    currencyCode,
                    paymentMethod: 'BANK_TRANSFER',
                    treasuryAccountId,
                    projectId,
                    departmentId,
                    costCentreId,
                    fundingSourceId,
                    verificationStatus: VerificationStatus.PENDING_VERIFICATION,
                    source: 'IMPORT',
                    importDate,
                    createdById: ctx.actor.userId,
                    submittedById: ctx.actor.userId,
                    submittedAt: new Date(),
                    approvedById: ctx.actor.userId,
                    approvedAt: new Date(),
                    postedById: ctx.actor.userId,
                    postedAt: new Date(),
                  },
                  select: { id: true },
                });

                const period = await tx.financialPeriod.findFirst({
                  where: {
                    organizationId: orgId,
                    status: 'OPEN',
                    startDate: { lte: date },
                    endDate: { gte: date },
                  },
                  orderBy: { startDate: 'asc' },
                  select: { id: true },
                });

                if (!period) {
                  throw new ValidationError('No open financial period found for transaction date', {
                    details: { organizationId: orgId, date: date.toISOString() },
                  });
                }

                const primaryAccount = await tx.account.findFirst({
                  where: { organizationId: orgId, type: 'ASSET', subCategory: 'BANK', isPostable: true },
                  orderBy: { code: 'asc' },
                  select: { id: true, normalBalance: true },
                });

                if (!primaryAccount) {
                  throw new ValidationError('No postable bank asset account found', { details: { organizationId: orgId } });
                }

                const journalEntry = await tx.journalEntry.create({
                  data: {
                    organizationId: orgId,
                    periodId: period.id,
                    type: JournalEntryType.STANDARD,
                    status: JournalEntryStatus.POSTED,
                    source: JournalSource.IMPORT,
                    reference,
                    description: `Imported from ${batch.code} row ${row.rowNumber}: ${description}`,
                    transactionId: transaction.id,
                    postedById: ctx.actor.userId,
                    postedAt: new Date(),
                  },
                  select: { id: true },
                });

                const primaryIsDebitNormal = primaryAccount.normalBalance === 'DEBIT';
                let primaryDebit = 0;
                let primaryCredit = 0;
                let counterpartyDebit = 0;
                let counterpartyCredit = 0;

                if (isDebit) {
                  if (primaryIsDebitNormal) {
                    primaryDebit = amount;
                    counterpartyCredit = amount;
                  } else {
                    primaryCredit = amount;
                    counterpartyDebit = amount;
                  }
                } else {
                  if (primaryIsDebitNormal) {
                    primaryCredit = amount;
                    counterpartyDebit = amount;
                  } else {
                    primaryDebit = amount;
                    counterpartyCredit = amount;
                  }
                }

                await tx.journalLine.createMany({
                  data: [
                    {
                      organizationId: orgId,
                      entryId: journalEntry.id,
                      accountId: primaryAccount.id,
                      lineNumber: 1,
                      description: `Imported: ${description}`,
                      debit: primaryDebit,
                      credit: primaryCredit,
                      currencyCode,
                      baseAmount: primaryDebit > 0 ? primaryDebit : primaryCredit,
                      fxRate: currencyCode === 'TZS' ? new Decimal(1) : null,
                      projectId,
                      departmentId,
                      costCentreId,
                      fundingSourceId,
                    },
                    {
                      organizationId: orgId,
                      entryId: journalEntry.id,
                      accountId: defaultLiabilityAccount.id,
                      lineNumber: 2,
                      description: `Counterparty for import ${batch.code} row ${row.rowNumber}`,
                      debit: counterpartyDebit,
                      credit: counterpartyCredit,
                      currencyCode,
                      baseAmount: counterpartyDebit > 0 ? counterpartyDebit : counterpartyCredit,
                      fxRate: currencyCode === 'TZS' ? new Decimal(1) : null,
                      projectId,
                      departmentId,
                      costCentreId,
                      fundingSourceId,
                    },
                  ],
                });

                await tx.importRow.update({
                  where: { id: row.id },
                  data: {
                    status: 'IMPORTED',
                    importedTransactionId: transaction.id,
                  },
                });

                results.push({
                  transactionId: transaction.id,
                  journalEntryId: journalEntry.id,
                  rowNumber: row.rowNumber,
                  reference,
                  amount,
                });

                successCount++;
              } catch (rowError) {
                failCount++;
                await tx.importRow.update({
                  where: { id: row.id },
                  data: { status: 'ERROR' },
                });
                await tx.importError.create({
                  data: {
                    batchId: id,
                    rowId: row.id,
                    rowNumber: row.rowNumber,
                    type: 'SYSTEM',
                    field: 'commit',
                    originalValue: normalized,
                    message: rowError instanceof Error ? rowError.message : 'Failed to commit row',
                    severity: 'ERROR',
                  },
                });
              }
            }

            const finalStatus = failCount === 0 ? 'COMPLETED' : successCount > 0 ? 'PARTIALLY_COMPLETED' : 'FAILED';

            const updatedBatch = await tx.importBatch.update({
              where: { id },
              data: {
                status: finalStatus,
                importedById: ctx.actor.userId,
                importedAt: new Date(),
                validRows: successCount,
                errorRows: batch.errorRows + failCount,
              },
              select: { id: true, code: true, status: true, importedAt: true },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'IMPORT_EXECUTED',
                entityType: 'IMPORT_BATCH',
                entityId: batch.id,
                entityLabel: batch.code,
                description: `Committed import ${batch.code}: ${successCount} imported, ${failCount} failed`,
                changes: {
                  status: { from: 'APPROVED', to: finalStatus },
                  importedById: { from: null, to: ctx.actor.userId },
                  importedAt: { from: null, to: new Date().toISOString() },
                  validRows: { from: batch.validRows, to: successCount },
                  errorRows: { from: batch.errorRows, to: batch.errorRows + failCount },
                },
              },
              {
                organizationId: orgId,
                ipAddress: net.ipAddress,
                userAgent: net.userAgent,
                requestId: reqId,
                sessionId: ctx.actor.sessionId,
              },
            );

            return { status: 200, body: { data: { batch: updatedBatch, results, summary: { imported: successCount, failed: failCount, total: validRows.length } } } };
          },
        ),
    });

    if (outcome.kind === 'REPLAYED') {
      return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    }

    return ok(outcome.result, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}