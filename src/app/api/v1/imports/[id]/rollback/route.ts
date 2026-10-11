import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma, TransactionStatus, JournalEntryStatus } from '@/lib/db/prisma';
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

interface RollbackResult {
  deletedTransactions: number;
  deletedJournalEntries: number;
  deletedJournalLines: number;
  resetRows: number;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'STATEMENT_IMPORT', action: 'REVERSE' });

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
        importedAt: true,
        importedById: true,
      },
    });

    if (!batch) {
      return apiError(new NotFoundError('Import batch', id), reqId);
    }

    if (!['COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED'].includes(batch.status)) {
      return apiError(new ValidationError(`Cannot rollback in ${batch.status} status. Import must be completed or partially completed.`), reqId);
    }

    const importedRows = await prisma.importRow.findMany({
      where: { batchId: id, status: 'IMPORTED', importedTransactionId: { not: null } },
      select: { id: true, rowNumber: true, importedTransactionId: true },
    });

    if (importedRows.length === 0) {
      return apiError(new ValidationError('No imported transactions to rollback'), reqId);
    }

    const transactionIds = importedRows.map(r => r.importedTransactionId!).filter(Boolean);

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `POST /api/v1/imports/${id}/rollback`,
      actorId: ctx.actor.userId,
      body: {},
      handler: async () =>
        withAudit(
          {
            organizationId: ctx.actor.organizationId,
            actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
            ipAddress: net.ipAddress,
            userAgent: net.userAgent,
            requestId: reqId,
            sessionId: ctx.actor.sessionId,
          },
          async (tx) => {
            let deletedTransactions = 0;
            let deletedJournalEntries = 0;
            let deletedJournalLines = 0;

            for (const txnId of transactionIds) {
              const journalEntries = await tx.journalEntry.findMany({
                where: { transactionId: txnId, status: JournalEntryStatus.POSTED },
                select: { id: true },
              });

              for (const je of journalEntries) {
                const deletedLines = await tx.journalLine.deleteMany({
                  where: { entryId: je.id },
                });
                deletedJournalLines += deletedLines.count;

                await tx.journalEntry.delete({
                  where: { id: je.id },
                });
                deletedJournalEntries++;
              }

              await tx.transaction.delete({
                where: { id: txnId },
              });
              deletedTransactions++;
            }

            const resetRows = await tx.importRow.updateMany({
              where: { batchId: id, status: 'IMPORTED' },
              data: {
                status: 'VALID',
                importedTransactionId: null,
              },
            });

            await tx.importBatch.update({
              where: { id },
              data: {
                status: 'ROLLED_BACK',
                rolledBackById: ctx.actor.userId,
                rolledBackAt: new Date(),
                validRows: resetRows.count,
                importedById: null,
                importedAt: null,
              },
            });

            const result: RollbackResult = {
              deletedTransactions,
              deletedJournalEntries,
              deletedJournalLines,
              resetRows: resetRows.count,
            };

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'IMPORT_ROLLED_BACK',
                entityType: 'IMPORT_BATCH',
                entityId: batch.id,
                entityLabel: batch.code,
                description: `Rolled back import ${batch.code}: ${deletedTransactions} transactions, ${deletedJournalEntries} journal entries deleted`,
                changes: {
                  status: { from: batch.status, to: 'ROLLED_BACK' },
                  rolledBackById: { from: null, to: ctx.actor.userId },
                  rolledBackAt: { from: null, to: new Date().toISOString() },
                  importedById: { from: batch.importedById, to: null },
                  importedAt: { from: batch.importedAt?.toISOString() ?? null, to: null },
                  rollbackSummary: { from: null, to: result },
                },
              },
              {
                organizationId: ctx.actor.organizationId,
                ipAddress: net.ipAddress,
                userAgent: net.userAgent,
                requestId: reqId,
                sessionId: ctx.actor.sessionId,
              },
            );

            return { status: 200, body: { data: result } };
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